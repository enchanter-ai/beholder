/* scripts/mcp-wrap.ts — Stage A of the dogfood plan.
 *
 * Stdio middleware between Claude Code (or any MCP client) and an MCP server.
 * Each tools/call passes through Enchanter's hydra + sylph patterns; vetoes
 * are answered with a JSON-RPC error before reaching the real server. Each
 * tools/call result has secrets masked before being forwarded back.
 *
 *   parent ──stdin──▶ mcp-wrap ──stdin──▶ child server
 *          ◀─stdout──          ◀─stdout──
 *
 * Usage:
 *   enchanter mcp-wrap -- npx -y @modelcontextprotocol/server-filesystem /proj
 *
 * Wire into Claude Code by replacing one MCP server entry:
 *   "command": "enchanter", "args": ["mcp-wrap", "--", <original cmd…>]
 *
 * Events flow to the BusClient (default ws://127.0.0.1:3001/ws); a running
 * `enchanter inspect` will show every tool call live.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import { BusClient, DEFAULT_BROADCASTER_URL } from '../src/observability/bus-client.js';
import { matchCvePatterns, maskSecrets } from '../src/plugins/hydra.adapter.js';
import type { EnchantedEvent } from '../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Argv: everything after `--` is the wrapped server command
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const sepIdx = args.indexOf('--');
const childArgv = sepIdx >= 0 ? args.slice(sepIdx + 1) : args;

if (childArgv.length === 0) {
  process.stderr.write(
    'usage: enchanter mcp-wrap -- <mcp-server-cmd> [<args>...]\n' +
    'example: enchanter mcp-wrap -- npx -y @modelcontextprotocol/server-filesystem /tmp\n',
  );
  process.exit(2);
}

const [cmd, ...cmdArgs] = childArgv;
if (!cmd) process.exit(2);

const serverId = process.env['ENCHANTER_SERVER_ID'] ?? cmd;

// ---------------------------------------------------------------------------
// Spawn the wrapped MCP server
// ---------------------------------------------------------------------------
const isWindows = process.platform === 'win32';
const child = spawn(cmd, cmdArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: isWindows,
}) as ChildProcessByStdio<Writable, Readable, Readable>;

child.on('error', (err) => {
  process.stderr.write(`[enchanter mcp-wrap] failed to spawn '${cmd}': ${err.message}\n`);
  process.exit(1);
});
child.stderr.on('data', (chunk: Buffer) => {
  // Forward server stderr unchanged so users see real server errors.
  process.stderr.write(chunk);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else        process.exit(code ?? 0);
});

// ---------------------------------------------------------------------------
// Optional fan-out to a running enchanter inspector
// ---------------------------------------------------------------------------
const broadcaster = new BusClient(process.env['ENCHANTER_BUS_URL'] ?? DEFAULT_BROADCASTER_URL);
broadcaster.connect();

function emit(topic: string, phase: EnchantedEvent['phase'], payload: Record<string, unknown>, correlationId: string): void {
  const e: EnchantedEvent = {
    id:             randomUUID(),
    correlation_id: correlationId,
    session_id:     'mcp-wrap',
    phase,
    topic,
    source:         'mcp-wrap',
    budget_tier:    'HIGH',
    ts:             Date.now(),
    payload,
  };
  broadcaster.send(e);
}

// ---------------------------------------------------------------------------
// Sylph destructive-op patterns (mirrors W5 from sylph.adapter.ts) — kept
// inline so the wrapper has no plugin-runtime dependency.
// ---------------------------------------------------------------------------
const SYLPH_DESTRUCTIVE_PATTERNS: ReadonlyArray<{ id: string; match: RegExp; reason: string }> = [
  { id: 'w5-force-push',    match: /\bgit\s+push\s+(?:[^|]*\s+)?(?:--force|-f)\b/,                 reason: 'force-push blocks history rewrite' },
  { id: 'w5-reset-hard',    match: /\bgit\s+reset\s+--hard\b/,                                     reason: 'git reset --hard discards uncommitted work' },
  { id: 'w5-branch-delete', match: /\bgit\s+branch\s+-D\b/,                                        reason: 'forced branch delete is irreversible' },
  { id: 'w5-clean-fdx',     match: /\bgit\s+clean\s+-[a-z]*[fdx][a-z]*\b/,                         reason: 'git clean -fdx wipes untracked files' },
  { id: 'w5-checkout-orig', match: /\bgit\s+checkout\s+--\s+\.|\bgit\s+restore\s+\.|\bgit\s+restore\s+--source/, reason: 'restoring tree discards local edits' },
  { id: 'w5-rm-tracked',    match: /\bgit\s+rm\s+-rf?\b/,                                          reason: 'recursive git rm wipes tracked tree' },
];

function matchSylphPatterns(corpus: string): { id: string; reason: string } | null {
  for (const p of SYLPH_DESTRUCTIVE_PATTERNS) {
    if (p.match.test(corpus)) return { id: p.id, reason: p.reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// JSON-RPC framing — newline-delimited
// ---------------------------------------------------------------------------
interface JsonRpcRequest  { jsonrpc: '2.0'; id?: string | number; method: string; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } }

let parentBuf = '';
process.stdin.on('data', (chunk: Buffer) => {
  parentBuf += chunk.toString('utf8');
  const lines = parentBuf.split('\n');
  parentBuf = lines.pop() ?? '';
  for (const line of lines) if (line.trim()) handleParentLine(line);
});

let childBuf = '';
child.stdout.on('data', (chunk: Buffer) => {
  childBuf += chunk.toString('utf8');
  const lines = childBuf.split('\n');
  childBuf = lines.pop() ?? '';
  for (const line of lines) if (line.trim()) handleChildLine(line);
});

// ---------------------------------------------------------------------------
// Parent → child: hydra + sylph veto check before forwarding
// ---------------------------------------------------------------------------
function handleParentLine(line: string): void {
  let req: JsonRpcRequest;
  try { req = JSON.parse(line) as JsonRpcRequest; }
  catch { child.stdin.write(line + '\n'); return; }

  if (req.method !== 'tools/call') {
    // initialize / tools/list / notifications / ... pass through unchanged.
    child.stdin.write(line + '\n');
    return;
  }

  const params = (req.params ?? {}) as Record<string, unknown>;
  const tool = typeof params['name'] === 'string' ? params['name'] as string : '';
  const toolArgs = (params['arguments'] ?? {}) as Record<string, unknown>;
  const correlationId = `wrap-${Date.now()}-${randomUUID().slice(0, 8)}`;

  emit('mcp.tool.call.requested', 'trust-gate', {
    tool, args: toolArgs, server_id: serverId,
  }, correlationId);

  // Build the same multi-corpus view hydra/sylph use: stringified payload
  // plus reconstructed command line `<tool> <args.join(' ')>` to defeat
  // array-arg evasion.
  const argString = Array.isArray(toolArgs['command']) ? (toolArgs['command'] as unknown[]).join(' ')
                  : typeof toolArgs['command'] === 'string' ? toolArgs['command'] as string
                  : Array.isArray(params['arguments']) ? (params['arguments'] as unknown[]).join(' ')
                  : JSON.stringify(toolArgs);
  const corpus = `${tool} ${argString}`.trim() + '\n' + JSON.stringify(toolArgs);

  // Hydra check — critical CVE patterns block.
  const cveHits = matchCvePatterns(corpus);
  const critical = cveHits.find((h) => h.severity === 'critical');
  if (critical) {
    emit('hydra.veto.fired', 'trust-gate', {
      pattern_id: critical.id,
      reason: critical.description ?? 'critical CVE pattern matched',
      tool,
    }, correlationId);
    sendVetoToParent(req.id ?? null, 'hydra', critical.id, critical.description ?? 'security veto');
    return;
  }

  // Sylph check — destructive git/shell ops block.
  const sylphHit = matchSylphPatterns(corpus);
  if (sylphHit) {
    emit('sylph.destructive.veto', 'trust-gate', {
      pattern_id: sylphHit.id,
      reason:     sylphHit.reason,
      tool,
    }, correlationId);
    sendVetoToParent(req.id ?? null, 'sylph', sylphHit.id, sylphHit.reason);
    return;
  }

  // Allowed — forward to child.
  child.stdin.write(line + '\n');
  pendingByReqId.set(String(req.id ?? ''), { correlationId, tool, ts: Date.now() });
}

interface PendingCall { correlationId: string; tool: string; ts: number }
const pendingByReqId = new Map<string, PendingCall>();

function sendVetoToParent(id: string | number | null, plugin: string, patternId: string, reason: string): void {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32001,
      message: `Enchanter veto: ${reason}`,
      data: { plugin, pattern_id: patternId },
    },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

// ---------------------------------------------------------------------------
// Child → parent: hydra secret-mask before forwarding
// ---------------------------------------------------------------------------
function handleChildLine(line: string): void {
  let resp: JsonRpcResponse;
  try { resp = JSON.parse(line) as JsonRpcResponse; }
  catch { process.stdout.write(line + '\n'); return; }

  // Mask secrets in tool result content. MCP returns content as an array of
  // {type, text} blocks; we only mask the text fields.
  let outLine = line;
  if (resp.result && typeof resp.result === 'object') {
    const result = resp.result as { content?: Array<{ type?: string; text?: string }> };
    if (Array.isArray(result.content)) {
      let mutated = false;
      const matchedIds: string[] = [];
      for (const block of result.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          const { masked, matched } = maskSecrets(block.text);
          if (matched.length > 0) {
            block.text = masked;
            matched.forEach((m) => matchedIds.push(m));
            mutated = true;
          }
        }
      }
      if (mutated) {
        outLine = JSON.stringify(resp);
        const pending = pendingByReqId.get(String(resp.id ?? ''));
        emit('hydra.secret.masked', 'post-response', {
          patterns: matchedIds,
          tool: pending?.tool,
        }, pending?.correlationId ?? 'mcp-wrap');
      }
    }
  }

  // Observability: pech ledger + general result-received event.
  const pending = pendingByReqId.get(String(resp.id ?? ''));
  if (pending) {
    const elapsed = Date.now() - pending.ts;
    emit('mcp.tool.result.received', 'post-response', {
      tool: pending.tool, elapsed_ms: elapsed, server_id: serverId,
    }, pending.correlationId);
    emit('pech.ledger.appended', 'post-response', {
      vendor: serverId, plugin: 'mcp-wrap', input_tokens: 0, output_tokens: 0, tool: pending.tool,
    }, pending.correlationId);
    pendingByReqId.delete(String(resp.id ?? ''));
  }

  process.stdout.write(outLine + '\n');
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
process.on('SIGINT',  () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function shutdown(code: number): void {
  try { broadcaster.close(); } catch { /* ignore */ }
  try { child.kill(); }       catch { /* ignore */ }
  process.exit(code);
}
