#!/usr/bin/env node
/* scripts/hooks/claude-code-emit.mjs — Claude Code session hook → JSONL bridge.
 *
 * Invoked by Claude Code's hook subsystem on each lifecycle event
 * (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop,
 * SubagentStop, SessionEnd). Reads the hook JSON payload from stdin,
 * translates it into one or more enchanter wire-schema events, and
 * appends them as JSONL to the user's local cache file. The Rust
 * inspector consumes that file via `enchanter inspect --tail <path>`.
 *
 *   claude-code lifecycle ──▶ this script ──▶ ~/.cache/enchanter/claude-code.jsonl
 *                                              ──▶ enchanter inspector
 *
 * Wire schema: docs/event-schema.md.
 *
 * Contract:
 *   - Stdlib-only (Node 22+). No deps. No build step.
 *   - Never throws. Never writes to stdout (Claude Code captures stdout
 *     into its own message stream). Errors → sibling .err file.
 *   - Always exits 0 — a non-zero exit is treated by Claude Code as a
 *     hook failure and surfaces a user-visible error.
 *   - 16 KB per-line cap on emitted events (well under the 1 MiB the
 *     inspector parser tolerates) — tool args + tool outputs are
 *     truncated. Privacy: nothing leaves the local machine.
 *
 * Invocation:
 *   node claude-code-emit.mjs --event PreToolUse < hook-payload.json
 *   CLAUDE_HOOK_EVENT=PreToolUse node claude-code-emit.mjs < hook-payload.json
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// --------------------------------------------------------------------------
// Paths — same algorithm as inspector/src/main.rs::log_path():
// XDG_CACHE_HOME → LOCALAPPDATA → HOME/.cache → tmpdir, then `enchanter/`.
// --------------------------------------------------------------------------
function resolveCacheBase() {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && xdg.length > 0) return xdg;
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local && local.length > 0) return local;
  }
  const home = process.env.HOME || os.homedir();
  if (home && home.length > 0) return path.join(home, '.cache');
  return os.tmpdir();
}

const cacheDir = path.join(resolveCacheBase(), 'enchanter');
const outPath = path.join(cacheDir, 'claude-code.jsonl');
const errPath = path.join(cacheDir, 'claude-code.err');

// --------------------------------------------------------------------------
// Logging helpers — never throw, never touch stdout.
// --------------------------------------------------------------------------
function ensureCacheDir() {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    /* swallow — best-effort */
  }
}

function logError(msg, err) {
  try {
    ensureCacheDir();
    const tail = err === undefined ? '' : ` ${err && err.message ? err.message : String(err)}`;
    fs.appendFileSync(errPath, `[${new Date().toISOString()}] ${msg}${tail}\n`);
  } catch {
    /* swallow — logging must never throw */
  }
}

// --------------------------------------------------------------------------
// File rotation — mirror inspector's MAX_LOG_BYTES = 5 MB.
// --------------------------------------------------------------------------
const MAX_BYTES = 5 * 1024 * 1024;

function rotateIfLarge() {
  try {
    const st = fs.statSync(outPath);
    if (st.size <= MAX_BYTES) return;
    const backup = `${outPath}.1`;
    // Try rename-swap first (preserves history in .1). On Windows, this
    // fails while the inspector has the file open for tailing. Fall back
    // to truncate-in-place — the tailer's `metadata.len() < read_offset`
    // detection treats truncation as rotation, so the consumer side is
    // unchanged. We lose the .1 archive in the truncate path; acceptable
    // tradeoff vs. dropping events because rename was blocked.
    try {
      fs.unlinkSync(backup);
    } catch {
      /* fine if missing */
    }
    try {
      fs.renameSync(outPath, backup);
    } catch {
      // Rename blocked (most likely Windows + open handle). Truncate.
      fs.truncateSync(outPath, 0);
    }
  } catch {
    /* file doesn't exist yet — nothing to rotate */
  }
}

// --------------------------------------------------------------------------
// Truncation — keep lines under 16 KB.
// --------------------------------------------------------------------------
const MAX_LINE_BYTES = 16 * 1024;
const MAX_FIELD_CHARS = 4096; // per-field cap on stringified args/output

function truncStr(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_FIELD_CHARS) return value;
  return value.slice(0, MAX_FIELD_CHARS) + `…[+${value.length - MAX_FIELD_CHARS} chars]`;
}

function truncArgs(args) {
  // Claude Code's tool_input is an object; stringify each top-level value
  // and cap. Strings get sliced; objects/arrays get JSON-stringified then sliced.
  if (args === null || typeof args !== 'object') {
    return truncStr(typeof args === 'string' ? args : JSON.stringify(args ?? null));
  }
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string') {
      out[k] = truncStr(v);
    } else if (typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v;
    } else {
      let s;
      try {
        s = JSON.stringify(v);
      } catch {
        s = String(v);
      }
      out[k] = truncStr(s);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// Append one event.
// --------------------------------------------------------------------------
function appendEvent(record) {
  let line;
  try {
    line = JSON.stringify(record);
  } catch (err) {
    logError('serialize failed', err);
    return;
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
    // Last-ditch: drop bulky payload field, keep envelope.
    const lean = { ...record };
    if ('payload' in lean) lean.payload = { _truncated: true };
    try {
      line = JSON.stringify(lean);
    } catch {
      logError('serialize failed after lean retry');
      return;
    }
  }
  try {
    ensureCacheDir();
    rotateIfLarge();
    fs.appendFileSync(outPath, line + '\n');
  } catch (err) {
    logError('append failed', err);
  }
}

// --------------------------------------------------------------------------
// Argv + env: extract the hook event name.
// --------------------------------------------------------------------------
function extractEvent() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--event' && i + 1 < argv.length) return argv[i + 1];
    if (argv[i].startsWith('--event=')) return argv[i].slice('--event='.length);
  }
  return process.env.CLAUDE_HOOK_EVENT || '';
}

// --------------------------------------------------------------------------
// Stdin → JSON. Returns {} on any failure.
// --------------------------------------------------------------------------
async function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        if (buf.length > 1024 * 1024) {
          // Ignore oversized payloads; Claude Code doesn't send these
          // under normal use and we never want to OOM a hook.
          buf = buf.slice(0, 1024 * 1024);
        }
      });
      process.stdin.on('end', () => {
        if (!buf.trim()) return finish({});
        try {
          finish(JSON.parse(buf));
        } catch (err) {
          logError('stdin not JSON', err);
          finish({});
        }
      });
      process.stdin.on('error', (err) => {
        logError('stdin error', err);
        finish({});
      });
    } catch (err) {
      logError('stdin setup failed', err);
      finish({});
    }
    // Safety belt: if stdin is a TTY (no piped payload), don't hang.
    if (process.stdin.isTTY) finish({});
  });
}

// --------------------------------------------------------------------------
// Event mapping.
// --------------------------------------------------------------------------
function nowSec() {
  return Date.now() / 1000;
}

function emitForHook(eventName, payload) {
  const time = nowSec();
  const session_id = typeof payload.session_id === 'string' ? payload.session_id : undefined;

  const base = (extra) => {
    const r = { time, ...extra };
    if (session_id) r.session_id = session_id;
    return r;
  };

  switch (eventName) {
    case 'SessionStart': {
      const r = base({ type: 'session.started' });
      if (typeof payload.cwd === 'string') r.workspace = payload.cwd;
      // env field is reserved for the deployment env (dev/prod/etc.) on the
      // schema; pass through if Claude Code ever surfaces it, else omit.
      if (typeof payload.env === 'string') r.env = payload.env;
      appendEvent(r);
      break;
    }

    case 'UserPromptSubmit': {
      const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
      appendEvent(
        base({
          type: 'lifecycle.anchor',
          plugin: 'orchestrator',
          phase: 'anchor',
          payload: { prompt_chars: prompt.length },
        }),
      );
      break;
    }

    case 'PreToolUse': {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown';
      const toolInput = payload.tool_input;
      appendEvent(
        base({
          type: 'mcp.tool.call.requested',
          plugin: 'mcp-client',
          phase: 'trust-gate',
          tool: toolName,
          payload: { args: truncArgs(toolInput) },
        }),
      );
      break;
    }

    case 'PostToolUse': {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown';
      const response = payload.tool_response ?? payload.response ?? {};
      const durationMs =
        typeof payload.duration_ms === 'number'
          ? payload.duration_ms
          : typeof payload.duration === 'number'
            ? payload.duration
            : undefined;
      // Output character count — best-effort across Claude Code's various
      // response shapes (string content / structured object / wrapped).
      let outputChars = 0;
      try {
        if (typeof response === 'string') outputChars = response.length;
        else outputChars = JSON.stringify(response).length;
      } catch {
        outputChars = 0;
      }
      const resultPayload = { output_chars: outputChars };
      if (durationMs !== undefined) resultPayload.duration_ms = durationMs;
      appendEvent(
        base({
          type: 'mcp.tool.result.received',
          plugin: 'mcp-client',
          phase: 'post-response',
          tool: toolName,
          payload: resultPayload,
        }),
      );

      // Optional pech.ledger emission when usage info is present.
      const usage =
        (response && typeof response === 'object' && response.usage) ||
        payload.usage ||
        undefined;
      if (usage && typeof usage === 'object') {
        const inTok = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
        const outTok = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
        const cost = Number(usage.cost_usd ?? 0);
        if (inTok > 0 || outTok > 0 || cost > 0) {
          appendEvent(
            base({
              type: 'pech.ledger.appended',
              plugin: 'pech',
              phase: 'post-response',
              input_tokens: inTok,
              output_tokens: outTok,
              cost_usd: cost,
            }),
          );
        }
      }
      break;
    }

    case 'SubagentStop': {
      const taskId =
        typeof payload.subagent_id === 'string'
          ? payload.subagent_id
          : typeof payload.task_id === 'string'
            ? payload.task_id
            : undefined;
      const r = base({ type: 'task.completed' });
      if (taskId) r.task_id = taskId;
      appendEvent(r);
      break;
    }

    case 'Stop': {
      appendEvent(base({ type: 'lifecycle.post-session', phase: 'post-session' }));
      break;
    }

    case 'SessionEnd': {
      appendEvent(base({ type: 'session.closed' }));
      break;
    }

    case 'PreCompact': {
      // Surface compaction as a generic phase event for visibility.
      appendEvent(base({ type: 'phase.entered', phase: 'cross-session', plugin: 'compactor' }));
      break;
    }

    default: {
      // Unknown hook event — log once for diagnostics, don't emit.
      logError(`unknown hook event: ${eventName}`);
      break;
    }
  }
}

// --------------------------------------------------------------------------
// Main — wrap everything so a thrown error becomes a logged note + exit 0.
// --------------------------------------------------------------------------
(async function main() {
  try {
    const eventName = extractEvent();
    if (!eventName) {
      logError('missing hook event name (set --event or CLAUDE_HOOK_EVENT)');
      process.exit(0);
      return;
    }
    const payload = await readStdinJson();
    emitForHook(eventName, payload || {});
  } catch (err) {
    logError('unhandled', err);
  } finally {
    // Always 0 — never break the caller.
    process.exit(0);
  }
})();
