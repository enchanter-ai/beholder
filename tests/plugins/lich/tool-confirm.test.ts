/* tests/plugins/lich/tool-confirm.test.ts — v0.3.2 (M5 tool-call confirmation).
   Covers runSandboxedToolCall() happy path / mismatch / timeout, plus the
   adapter wire-up around the m5_tool_confirm config flag. Sibling to
   sandbox.test.ts; the existing CODE-REVIEW sandbox stays untouched. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  runSandboxedToolCall,
  type ToolConfirmResult,
} from '../../../src/plugins/lich/sandbox.js';
import {
  lichAdapter,
  configureLich,
} from '../../../src/plugins/lich.adapter.js';
import { runSandboxedReview, runSandboxedToolCall as realToolConfirm } from '../../../src/plugins/lich/sandbox.js';
import { createRequestContext } from '../../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../../src/bus/event-types.js';

const ctx = createRequestContext();

afterEach(() => {
  configureLich({
    m5_sandbox: false,
    m5_time_budget_ms: 5000,
    m5_sandbox_runner: runSandboxedReview,
    m5_tool_confirm: false,
    m5_tool_confirm_runner: realToolConfirm,
  });
});

function makeEvent(payload: Record<string, unknown>): EnchantedEvent {
  return {
    id: 'tc-id', correlation_id: 'tc-corr', session_id: 'tc-sess',
    phase: 'post-response', topic: 'mcp.tool.result.received',
    source: 'orchestrator', budget_tier: 'HIGH', ts: Date.now(),
    payload,
  };
}

describe('runSandboxedToolCall — replay isolation', () => {
  it('happy path: replay matches → ok:true, no differences', async () => {
    // The worker's mockReplay returns { tool, echo: params }. We pass a live
    // response of the same shape — should match exactly.
    const params = { city: 'Berlin', units: 'metric' };
    const live = { tool: 'weather', echo: { city: 'Berlin', units: 'metric' } };

    const result = await runSandboxedToolCall('weather', params, live, {
      time_budget_ms: 4000,
    });
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(true);
      expect(result.differences).toEqual([]);
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('mismatch: replay differs → ok:false, differences populated', async () => {
    // Live response carries an injected `next_tool` field and mutated echo.
    const params = { city: 'Berlin' };
    const live = {
      tool: 'weather',
      echo: { city: 'Tokyo' },        // mutated
      next_tool: 'exfiltrate',         // injected
    };

    const result = await runSandboxedToolCall('weather', params, live, {
      time_budget_ms: 4000,
    });
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(false);
      expect(result.differences.length).toBeGreaterThan(0);
      // Each diff carries path/original/replayed.
      for (const d of result.differences) {
        expect(Array.isArray(d.path)).toBe(true);
      }
      // The injected `next_tool` field shows up as a divergence.
      const paths = result.differences.map((d) => d.path.join('.'));
      expect(paths).toContain('next_tool');
    }
  });

  it('timeout: spinning worker is killed and returns timeout', async () => {
    const result = await runSandboxedToolCall('any', {}, {}, {
      time_budget_ms: 250,
      _force_spin: true,
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('timeout');
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(250);
    }
  }, 4000);

  it('crash: worker error returns worker-error reason (not throw)', async () => {
    const result = await runSandboxedToolCall('any', {}, {}, {
      time_budget_ms: 4000,
      _force_crash: true,
    });
    expect(result.failed).toBe(true);
    if (result.failed) {
      expect(result.reason).toBe('worker-error');
    }
  });

  it('mismatch: arrays of primitives compared as multiset (order-insensitive)', async () => {
    // Use _replay_override so the test can drive a specific replay payload
    // without depending on the default projection.
    const params = {
      _replay_override: { tags: ['a', 'b', 'c'] },
    };
    // Same elements, different order → no diff.
    const live = { tags: ['c', 'a', 'b'] };

    const result = await runSandboxedToolCall('t', params, live, {
      time_budget_ms: 4000,
    });
    expect(result.failed).toBe(false);
    if (!result.failed) {
      expect(result.ok).toBe(true);
    }
  });
});

describe('lich adapter — m5_tool_confirm config flag wire-up', () => {
  it('flag OFF (default): no tool-confirm event produced', async () => {
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { tool: 'weather', echo: { city: 'Berlin' } },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm';
    });
    expect(tc).toBeUndefined();
  });

  it('flag ON + matching replay: produces tool-confirm event with ok:true', async () => {
    configureLich({ m5_tool_confirm: true, m5_time_budget_ms: 4000 });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { tool: 'weather', echo: { city: 'Berlin' } },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm';
    });
    expect(tc).toBeDefined();
    const p = tc!.payload as { failed: boolean; ok?: boolean };
    expect(p.failed).toBe(false);
    expect(p.ok).toBe(true);
  });

  it('flag ON + diverging replay: ack flagged degraded with diff summary', async () => {
    configureLich({ m5_tool_confirm: true, m5_time_budget_ms: 4000 });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      // Live response carries an injected field — replay won't match.
      response: { tool: 'weather', echo: { city: 'Berlin' }, exfil: 'secret' },
    }), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.reason).toContain('lich-tool-confirm-divergence');
  });

  it('flag ON + sandbox failure: ack marked degraded (fail-open)', async () => {
    configureLich({
      m5_tool_confirm: true,
      m5_tool_confirm_runner: async (): Promise<ToolConfirmResult> => ({
        failed: true,
        reason: 'timeout',
        detail: 'forced',
        elapsed_ms: 12,
      }),
    });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { tool: 'weather', echo: { city: 'Berlin' } },
    }), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.reason).toContain('lich-tool-confirm-timeout');
  });

  it('flag ON + no tool/response in payload: no tool-confirm event produced', async () => {
    configureLich({ m5_tool_confirm: true });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === 'tool-confirm';
    });
    expect(tc).toBeUndefined();
  });

  it('coexists with m5_sandbox: both variants can run on the same event', async () => {
    configureLich({ m5_sandbox: true, m5_tool_confirm: true, m5_time_budget_ms: 4000 });
    const ack = await lichAdapter.onPhase(makeEvent({
      tool_schema: { name: 't', description: 'clean', inputSchema: { properties: {} } },
      code: 'const x = 1;',
      tool: 'weather',
      args: { city: 'Berlin' },
      response: { tool: 'weather', echo: { city: 'Berlin' } },
    }), ctx);
    expect(ack.status).toBe('ack');
    const evs = ack.derived_events ?? [];
    const tc = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return p.variant === 'tool-confirm';
    });
    const sb = evs.find((e) => {
      const p = e.payload as { variant?: string };
      return e.topic === 'lich.sandbox.executed' && p.variant === undefined;
    });
    expect(tc).toBeDefined();
    expect(sb).toBeDefined();
  });
});
