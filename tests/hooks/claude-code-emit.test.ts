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
    // PreToolUse now emits the base mcp.tool.call.requested AND a derived
    // crow.trust.scored. The first line is the base event.
    expect(lines).toHaveLength(2);
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

  // ----------------------------------------------------------------------
  // Derived plugin events — one PreToolUse fires the base mcp.* event AND
  // a derived crow.trust.scored event from accumulated per-session state.
  // ----------------------------------------------------------------------
  it('emits crow.trust.scored alongside mcp.tool.call.requested on PreToolUse', () => {
    const { code, jsonlPath } = runHook('PreToolUse', {
      session_id: 'sess-derived-1',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/foo.txt' },
    });
    expect(code).toBe(0);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const base = JSON.parse(lines[0]);
    const derived = JSON.parse(lines[1]);
    expect(base.type).toBe('mcp.tool.call.requested');
    expect(derived.type).toBe('crow.trust.scored');
    expect(derived.plugin).toBe('crow');
    expect(derived.tool_name).toBe('Read');
    // First call, no errors yet → posterior_mean = 1.0.
    expect(derived.posterior_mean).toBe(1.0);
    expect(derived.observation_count).toBe(1);
  });

  it('emits djinn.anchor.set on first UserPromptSubmit and emu.context_update', () => {
    const { code, jsonlPath } = runHook('UserPromptSubmit', {
      session_id: 'sess-anchor-1',
      prompt: 'Refactor the auth router to support OIDC.',
    });
    expect(code).toBe(0);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain('lifecycle.anchor');
    expect(types).toContain('djinn.anchor.set');
    expect(types).toContain('emu.context_update');
    const emu = JSON.parse(lines.find((l) => JSON.parse(l).type === 'emu.context_update')!);
    // 200 - turn_count(=1) = 199.
    expect(emu.turn_estimate).toBe(199);
    expect(emu.plugin).toBe('emu');
  });

  it('emits djinn.drift.observed (not anchor.set) on subsequent UserPromptSubmit', () => {
    runHook('UserPromptSubmit', {
      session_id: 'sess-drift-1',
      prompt: 'Refactor the auth router to support OIDC.',
    });
    const { code, jsonlPath } = runHook('UserPromptSubmit', {
      session_id: 'sess-drift-1',
      prompt: 'Now write a haiku about a unicorn.',
    });
    expect(code).toBe(0);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain('djinn.drift.observed');
    // Anchor set fires once per session, not on the second prompt.
    const anchorSets = types.filter((t) => t === 'djinn.anchor.set');
    expect(anchorSets).toHaveLength(1);
    const drift = JSON.parse(lines.find((l) => JSON.parse(l).type === 'djinn.drift.observed')!);
    expect(drift.drift).toBeGreaterThan(0);
    expect(drift.drift).toBeLessThanOrEqual(0.5);
  });

  it('emits naga.spec_check + lich.review on PostToolUse for Edit', () => {
    const { code, jsonlPath } = runHook('PostToolUse', {
      session_id: 'sess-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/router.ts' },
      tool_response: { content: 'ok' },
    });
    expect(code).toBe(0);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    const types = lines.map((l) => JSON.parse(l).type);
    expect(types).toContain('mcp.tool.result.received');
    expect(types).toContain('naga.spec_check');
    expect(types).toContain('lich.review');
    const naga = JSON.parse(lines.find((l) => JSON.parse(l).type === 'naga.spec_check')!);
    expect(naga.status).toBe('clean');
    expect(naga.file).toBe('/repo/src/router.ts');
  });
});
