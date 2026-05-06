/* tests/hooks/claude-code-emit.test.ts — smoke check for the Claude Code hook emitter.
 *
 * Spawns the .mjs script with a fake stdin payload, asserts that a JSONL line
 * appears in the configured cache file. Uses XDG_CACHE_HOME (and LOCALAPPDATA
 * on Windows) to redirect output into a tmpdir so the test never touches the
 * developer's real cache.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'hooks', 'claude-code-emit.mjs');

let cacheRoot: string;

function runHook(eventName: string, payload: unknown): { code: number | null; jsonlPath: string } {
  const result = spawnSync('node', [SCRIPT, '--event', eventName], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      ...process.env,
      // Redirect both the POSIX and Windows cache resolutions into our tmpdir
      // so neither host's real cache file is mutated.
      XDG_CACHE_HOME: cacheRoot,
      LOCALAPPDATA: cacheRoot,
      HOME: cacheRoot,
    },
  });
  return { code: result.status, jsonlPath: join(cacheRoot, 'enchanter', 'claude-code.jsonl') };
}

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'enchanter-cc-hook-'));
});

afterEach(() => {
  try {
    rmSync(cacheRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('claude-code-emit.mjs', () => {
  it('writes a mcp.tool.call.requested line for PreToolUse', () => {
    const { code, jsonlPath } = runHook('PreToolUse', {
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo.txt' },
    });
    expect(code).toBe(0);
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const evt = JSON.parse(lines[0]);
    expect(evt.type).toBe('mcp.tool.call.requested');
    expect(evt.tool).toBe('Read');
    expect(evt.session_id).toBe('sess-1');
    expect(evt.phase).toBe('trust-gate');
    expect(evt.plugin).toBe('mcp-client');
    expect(typeof evt.time).toBe('number');
    expect(evt.payload.args.file_path).toBe('/tmp/foo.txt');
  });

  it('writes session.started for SessionStart with workspace', () => {
    const { code, jsonlPath } = runHook('SessionStart', {
      session_id: 'sess-2',
      cwd: '/some/repo',
    });
    expect(code).toBe(0);
    const evt = JSON.parse(readFileSync(jsonlPath, 'utf8').trim());
    expect(evt.type).toBe('session.started');
    expect(evt.session_id).toBe('sess-2');
    expect(evt.workspace).toBe('/some/repo');
  });

  it('emits both mcp.tool.result.received and pech.ledger.appended on PostToolUse with usage', () => {
    const { code, jsonlPath } = runHook('PostToolUse', {
      session_id: 'sess-3',
      tool_name: 'Edit',
      duration_ms: 42,
      tool_response: {
        content: 'ok',
        usage: { input_tokens: 100, output_tokens: 50, cost_usd: 0.001 },
      },
    });
    expect(code).toBe(0);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const a = JSON.parse(lines[0]);
    const b = JSON.parse(lines[1]);
    expect(a.type).toBe('mcp.tool.result.received');
    expect(a.tool).toBe('Edit');
    expect(a.payload.duration_ms).toBe(42);
    expect(b.type).toBe('pech.ledger.appended');
    expect(b.input_tokens).toBe(100);
    expect(b.output_tokens).toBe(50);
    expect(b.cost_usd).toBeCloseTo(0.001);
  });

  it('exits 0 even when the event name is unknown (never blocks Claude Code)', () => {
    const { code, jsonlPath } = runHook('TotallyMadeUpEvent', { session_id: 'x' });
    expect(code).toBe(0);
    // No JSONL line for unknown events; an .err sibling may exist.
    expect(existsSync(jsonlPath)).toBe(false);
  });

  it('exits 0 with no event name (logs to .err, never throws)', () => {
    const result = spawnSync('node', [SCRIPT], {
      input: '{}',
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_CACHE_HOME: cacheRoot,
        LOCALAPPDATA: cacheRoot,
        HOME: cacheRoot,
        CLAUDE_HOOK_EVENT: '',
      },
    });
    expect(result.status).toBe(0);
  });
});
