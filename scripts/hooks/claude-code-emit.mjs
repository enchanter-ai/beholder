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
const stateFile = path.join(cacheDir, 'plugin-state.json');

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
// Per-session plugin-state — accumulates across hook invocations within one
// Claude Code session so derived events (crow trust posterior, gorgon
// hotspot file, djinn anchor drift, emu turn budget) can be computed from
// real history. Schema is documented in docs/claude-code-integration.md.
// File is rewritten atomically (write tmp + rename) so concurrent hook
// firings don't tear the JSON. Reset at SessionEnd.
// --------------------------------------------------------------------------
function makeFreshState(sessionId) {
  return {
    session_id: sessionId || '',
    turn_count: 0,
    tool_counts: {},
    tool_errors: {},
    file_access_counts: {},
    anchor_intent: '',
    last_prompt_text: '',
    started_at: nowSec(),
    gorgon_tick: 0,
    // Throttle for runtime.metrics heartbeat — emit every Nth PostToolUse.
    metrics_tick: 0,
    // Single-slot timing: pre_time stamped on PreToolUse, consumed on
    // PostToolUse to compute real duration_ms. Single slot is enough since
    // Claude Code calls tools serially in one session.
    pre_time: 0,
    pre_tool: '',
    // Inflight count — bumped on Pre, decremented on Post. Surfaces as
    // `tasks_active` in runtime.metrics so the cockpit shows non-zero while
    // a tool call is in progress.
    inflight_tools: 0,
    // Lifetime accumulators for runtime.metrics heartbeat.
    code_lines_added: 0,
    code_lines_removed: 0,
    files_modified: [], // array (serialised); used as Set on read
    files_created: [],
    pr_count: 0,
    tests_run: 0,
    tests_passed: 0,
    // Pech ledger — last seen byte offset into the active transcript and
    // cumulative session totals scanned from it.
    transcript_path: '',
    transcript_offset: 0,
    session_input_tokens: 0,
    session_output_tokens: 0,
    session_cost_usd: 0,
  };
}

function readState(sessionId) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      // If the cached state is from a different session, start fresh.
      if (sessionId && parsed.session_id && parsed.session_id !== sessionId) {
        return makeFreshState(sessionId);
      }
      // Backfill missing fields if older state file exists.
      const fresh = makeFreshState(sessionId);
      return { ...fresh, ...parsed };
    }
  } catch {
    /* missing or corrupt — fall through to fresh */
  }
  return makeFreshState(sessionId);
}

function writeState(state) {
  try {
    ensureCacheDir();
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    logError('plugin-state write failed', err);
  }
}

function resetState() {
  try {
    fs.unlinkSync(stateFile);
  } catch {
    /* fine if missing */
  }
}

// Word-overlap drift: 1.0 - (overlap / max(words(a), words(b))). Capped at 0.5.
function computeDrift(anchorText, currentText) {
  const tok = (s) =>
    String(s || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length >= 3);
  const a = new Set(tok(anchorText));
  const b = new Set(tok(currentText));
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const w of a) if (b.has(w)) overlap += 1;
  const denom = Math.max(a.size, b.size);
  const drift = 1.0 - overlap / denom;
  return Math.min(0.5, Math.max(0, drift));
}

// Best-effort: pull a file path off Claude Code's tool_input shape.
// Edit/Read/Write all use `file_path`; NotebookEdit uses `notebook_path`;
// Bash has no canonical file arg.
function extractFilePath(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const candidates = ['file_path', 'notebook_path', 'path'];
  for (const k of candidates) {
    const v = toolInput[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ----------------------------------------------------------------------------
// Hydra CWE pattern scan — runs over Bash commands at PreToolUse. Patterns
// follow the same shape as src/plugins/hydra.adapter.ts so the cockpit's
// security counter ticks for the same hazards in real Claude Code work.
// ----------------------------------------------------------------------------
const HYDRA_PATTERNS = [
  {
    id: 'cwe-78-rm-rf-root',
    cve_anchor: 'CWE-78: OS Command Injection',
    severity: 'critical',
    re: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|-[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-rf|-fr)\s+(\/(\s|$|\*)|~|\$HOME|\$\{HOME\})/,
  },
  {
    id: 'cwe-94-curl-pipe-shell',
    cve_anchor: 'CWE-94: Code Injection',
    severity: 'high',
    re: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|fish)\b/,
  },
  {
    id: 'cwe-200-private-key-read',
    cve_anchor: 'CWE-200: Information Exposure',
    severity: 'high',
    re: /\b(cat|less|more|head|tail|type)\b[^;|&]*\b(\.ssh\/id_(rsa|ed25519|ecdsa|dsa)|\.aws\/credentials|\.gnupg\/.+\.key)\b/,
  },
  {
    id: 'cwe-732-force-push',
    cve_anchor: 'CWE-732: Incorrect Permission Assignment',
    severity: 'medium',
    re: /\bgit\s+push\s+(-[a-zA-Z]*f|--force|--force-with-lease)\b/,
  },
  {
    id: 'cwe-732-chmod-777',
    cve_anchor: 'CWE-732: Incorrect Permission Assignment',
    severity: 'medium',
    re: /\bchmod\s+(-R\s+)?(777|666|a\+rwx|o\+rwx)\b/,
  },
];

function scanHydra(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const p of HYDRA_PATTERNS) {
    if (p.re.test(command)) return p;
  }
  return null;
}

// Detect test-runner invocations in Bash commands.
const TEST_CMD_RE = /\b(npm\s+(run\s+)?test|pnpm\s+(run\s+)?test|yarn\s+(run\s+)?test|jest|vitest|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|rspec|mocha|playwright)\b/;
function isTestCommand(command) {
  return typeof command === 'string' && TEST_CMD_RE.test(command);
}

// Detect `gh pr create` (PR creation).
function isPrCreate(command) {
  return typeof command === 'string' && /\bgh\s+pr\s+create\b/.test(command);
}

// Count newlines in a string.
function lineCount(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n += 1;
  return n;
}

// ----------------------------------------------------------------------------
// Transcript scan — Claude Code writes the full session JSONL to
// payload.transcript_path on Stop / SessionEnd. Each line carries a `message`
// with usage `{input_tokens, output_tokens, cache_*}` and (newer Claude
// versions) `costUSD`. We scan from the last seen byte offset and append
// only the delta to keep cost monotonically increasing.
// ----------------------------------------------------------------------------
function scanTranscript(transcriptPath, fromOffset) {
  const result = { input: 0, output: 0, cost: 0, newOffset: fromOffset };
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return result;
  }
  let st;
  try {
    st = fs.statSync(transcriptPath);
  } catch {
    return result;
  }
  // If transcript was rotated/truncated below fromOffset, restart from 0.
  let start = fromOffset;
  if (st.size < fromOffset) start = 0;
  if (st.size <= start) {
    result.newOffset = st.size;
    return result;
  }
  let buf;
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const len = st.size - start;
      buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    logError('transcript read failed', err);
    return result;
  }
  result.newOffset = st.size;
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    // Claude Code transcript shapes vary; usage lives under message.usage
    // for assistant turns. costUSD appears at the top level on newer builds.
    const usage =
      (row && row.message && row.message.usage) ||
      (row && row.usage) ||
      null;
    if (usage && typeof usage === 'object') {
      const i = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
      const o = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
      if (Number.isFinite(i) && i > 0) result.input += i;
      if (Number.isFinite(o) && o > 0) result.output += o;
      // Cache-creation/read tokens count toward input for budget purposes.
      const cc = Number(usage.cache_creation_input_tokens ?? 0);
      const cr = Number(usage.cache_read_input_tokens ?? 0);
      if (Number.isFinite(cc) && cc > 0) result.input += cc;
      if (Number.isFinite(cr) && cr > 0) result.input += cr;
    }
    const cost = Number(row && (row.costUSD ?? row.cost_usd ?? 0));
    if (Number.isFinite(cost) && cost > 0) result.cost += cost;
  }
  return result;
}

// Inspect tool_response for an error signal.
function isErrorResponse(response) {
  if (!response) return false;
  if (typeof response === 'string') return false;
  if (typeof response !== 'object') return false;
  if (response.error) return true;
  if (typeof response.status === 'string' && response.status !== 'ok') return true;
  if (response.is_error === true) return true;
  return false;
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

      // Derived plugin events ----------------------------------------------
      const state = readState(session_id);
      const isFirstPrompt = !state.anchor_intent;
      if (isFirstPrompt) {
        state.anchor_intent = prompt.slice(0, 200);
        // djinn.anchor.set on the first user prompt of the session — locks
        // the session intent that subsequent prompts get measured against.
        appendEvent(
          base({
            type: 'djinn.anchor.set',
            plugin: 'djinn',
            phase: 'anchor',
            intent: state.anchor_intent,
          }),
        );
      } else {
        // Subsequent prompts → drift relative to the locked anchor.
        const drift = computeDrift(state.anchor_intent, prompt);
        appendEvent(
          base({
            type: 'djinn.drift.observed',
            plugin: 'djinn',
            phase: 'post-session',
            drift,
            intent: state.anchor_intent,
          }),
        );
      }
      state.last_prompt_text = prompt.slice(0, 200);
      state.turn_count += 1;

      // emu.context_update — turns LEFT in a 200-turn budget, floored at 12
      // so the cockpit never flashes 0 (matches the live.ts demo behavior).
      const turnEstimate = Math.max(12, 200 - state.turn_count);
      appendEvent(
        base({
          type: 'emu.context_update',
          plugin: 'emu',
          phase: 'pre-dispatch',
          turn_estimate: turnEstimate,
          context_size: prompt.length,
        }),
      );

      writeState(state);
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

      // Hydra CWE scan — Bash only. Emits hydra.veto.fired on a hit; the
      // inspector's apply_unknown branch increments security_incidents_session
      // and bumps the hydra plugin's call counter.
      if (toolName === 'Bash' && toolInput && typeof toolInput === 'object') {
        const cmd = typeof toolInput.command === 'string' ? toolInput.command : '';
        const hit = scanHydra(cmd);
        if (hit) {
          appendEvent(
            base({
              type: 'hydra.veto.fired',
              plugin: 'hydra',
              phase: 'trust-gate',
              severity: hit.severity,
              pattern_id: hit.id,
              cve_anchor: hit.cve_anchor,
              tool: toolName,
              payload: { command: truncStr(cmd) },
            }),
          );
        }
      }

      // Derived plugin events ----------------------------------------------
      const state = readState(session_id);
      // Stamp pre_time + tool name so PostToolUse can compute duration_ms.
      state.pre_time = time;
      state.pre_tool = toolName;
      state.inflight_tools = (state.inflight_tools || 0) + 1;
      const total = (state.tool_counts[toolName] || 0) + 1;
      const errors = state.tool_errors[toolName] || 0;
      state.tool_counts[toolName] = total;

      // crow.trust.scored — Bayesian posterior_mean from observed errors.
      // Uniform prior 0.5 when total <= 0 (impossible here since we just
      // bumped it, so this branch is documentation for behavior).
      const posteriorMean = total > 0 ? 1.0 - errors / total : 0.5;
      appendEvent(
        base({
          type: 'crow.trust.scored',
          plugin: 'crow',
          phase: 'trust-gate',
          tool_name: toolName,
          posterior_mean: posteriorMean,
          observation_count: total,
        }),
      );

      // Track file access — fuels gorgon.hotspot on PostToolUse.
      const filePath = extractFilePath(toolName, toolInput);
      if (filePath) {
        state.file_access_counts[filePath] =
          (state.file_access_counts[filePath] || 0) + 1;
      }

      writeState(state);
      break;
    }

    case 'PostToolUse': {
      const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : 'unknown';
      const response = payload.tool_response ?? payload.response ?? {};
      // Read state up front — we need pre_time to derive a real duration when
      // Claude Code itself doesn't surface one in the hook payload.
      const stateForDuration = readState(session_id);
      const preTime =
        stateForDuration.pre_tool === toolName && stateForDuration.pre_time > 0
          ? stateForDuration.pre_time
          : 0;
      const derivedDurationMs =
        preTime > 0 ? Math.max(0, Math.round((time - preTime) * 1000)) : undefined;
      const durationMs =
        typeof payload.duration_ms === 'number'
          ? payload.duration_ms
          : typeof payload.duration === 'number'
            ? payload.duration
            : derivedDurationMs;
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

      // Derived plugin events ----------------------------------------------
      // Reuse the state we already loaded for duration computation.
      const state = stateForDuration;
      // Clear pre_time slot now that this tool's bracket is closed.
      state.pre_time = 0;
      state.pre_tool = '';
      if ((state.inflight_tools || 0) > 0) state.inflight_tools -= 1;

      // Bump error counter if the tool failed — this feeds the next call's
      // crow posterior_mean.
      if (isErrorResponse(response)) {
        state.tool_errors[toolName] = (state.tool_errors[toolName] || 0) + 1;
      }

      const toolInput = payload.tool_input || {};
      const filePath = extractFilePath(toolName, toolInput);
      const isMutator = toolName === 'Edit' || toolName === 'Write';
      const isReader = toolName === 'Read';

      // ---- LOC + file-modified accumulation (drives runtime.metrics) -----
      if (filePath) {
        if (toolName === 'Write') {
          if (!state.files_created.includes(filePath)) state.files_created.push(filePath);
          state.code_lines_added += lineCount(toolInput.content);
        } else if (toolName === 'Edit') {
          if (!state.files_modified.includes(filePath)) state.files_modified.push(filePath);
          const before = lineCount(toolInput.old_string);
          const after = lineCount(toolInput.new_string);
          if (after >= before) state.code_lines_added += after - before;
          else state.code_lines_removed += before - after;
        }
      }

      // ---- Bash classifier (tests / PRs) ---------------------------------
      if (toolName === 'Bash' && typeof toolInput.command === 'string') {
        if (isTestCommand(toolInput.command)) {
          state.tests_run += 1;
          if (!isErrorResponse(response)) state.tests_passed += 1;
        }
        if (isPrCreate(toolInput.command) && !isErrorResponse(response)) {
          state.pr_count += 1;
        }
      }

      // gorgon.hotspot — rate-limited to ~once every 5 hooks. Reports the
      // currently-hottest file from accumulated access counts. Skipped when
      // we have no access data yet (early in the session).
      state.gorgon_tick += 1;
      if (state.gorgon_tick % 5 === 0) {
        let topFile = null;
        let topCount = 0;
        let total = 0;
        for (const [f, c] of Object.entries(state.file_access_counts)) {
          total += c;
          if (c > topCount) {
            topCount = c;
            topFile = f;
          }
        }
        if (topFile && total > 0) {
          appendEvent(
            base({
              type: 'gorgon.hotspot',
              plugin: 'gorgon',
              phase: 'cross-session',
              file: topFile,
              heat: topCount / total,
            }),
          );
        }
      }

      // naga + lich — stub-clean verdicts on Edit/Write. Real spec/sandbox
      // analysis requires diff parsing (deferred); these stubs let the
      // PLUGINS table light up on real edit activity.
      if ((isMutator || isReader) && filePath) {
        if (isMutator) {
          appendEvent(
            base({
              type: 'naga.spec_check',
              plugin: 'naga',
              phase: 'post-response',
              file: filePath,
              status: 'clean',
              drift: 0,
            }),
          );
          appendEvent(
            base({
              type: 'lich.review',
              plugin: 'lich',
              phase: 'post-response',
              file: filePath,
              sandbox_depth: 0,
              status: 'clean',
            }),
          );
        }
      }

      // ---- runtime.metrics heartbeat (every 5th PostToolUse) -------------
      // Folded right here (not on a timer) so it stays stdlib-only and
      // emits exactly when something changed. The inspector's apply_unknown
      // path (state.rs:1834) reads every field off `extra`.
      state.metrics_tick = (state.metrics_tick || 0) + 1;
      if (state.metrics_tick % 5 === 0) {
        const totalToolCalls = Object.values(state.tool_counts).reduce((s, n) => s + n, 0);
        const testsRun = state.tests_run || 0;
        const testsPassed = state.tests_passed || 0;
        const passedRate = testsRun > 0 ? testsPassed / testsRun : 0;
        appendEvent(
          base({
            type: 'runtime.metrics',
            plugin: 'orchestrator',
            phase: 'cross-session',
            open_sessions: 1,
            ongoing_tasks: state.inflight_tools || 0,
            queued_tasks: 0,
            blocked_tasks: 0,
            tool_calls_lifetime: totalToolCalls,
            files_created_lifetime: state.files_created.length,
            files_modified_lifetime: state.files_modified.length,
            code_written_lifetime_loc: state.code_lines_added,
            code_modified_lifetime_loc: state.code_lines_removed,
            prs_created_lifetime: state.pr_count || 0,
            tests_run_lifetime: testsRun,
            tests_passed_rate: passedRate,
            total_spend_lifetime: state.session_cost_usd || 0,
          }),
        );
      }

      writeState(state);
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
      // Pech ledger: scan the Claude Code transcript JSONL for real token +
      // cost data and emit the cumulative session totals. payload.transcript_path
      // is provided by Claude Code on Stop / SessionEnd / SubagentStop hooks.
      // We track byte offset to avoid re-summing across multiple Stops in one
      // long session.
      const transcriptPath =
        typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
      if (transcriptPath) {
        const state = readState(session_id);
        // Reset the offset if Claude Code switched transcripts (rare).
        if (state.transcript_path !== transcriptPath) {
          state.transcript_path = transcriptPath;
          state.transcript_offset = 0;
        }
        const delta = scanTranscript(transcriptPath, state.transcript_offset);
        if (delta.input > 0 || delta.output > 0 || delta.cost > 0) {
          state.session_input_tokens += delta.input;
          state.session_output_tokens += delta.output;
          state.session_cost_usd += delta.cost;
          appendEvent(
            base({
              type: 'pech.ledger.appended',
              plugin: 'pech',
              phase: 'post-session',
              input_tokens: delta.input,
              output_tokens: delta.output,
              cost_usd: delta.cost,
              session_cost_usd: state.session_cost_usd,
              daily_cost_usd: state.session_cost_usd,
            }),
          );
        }
        state.transcript_offset = delta.newOffset;
        writeState(state);
      }
      break;
    }

    case 'SessionEnd': {
      appendEvent(base({ type: 'session.closed' }));
      // Wipe per-session plugin-state so the NEXT session starts clean.
      resetState();
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
