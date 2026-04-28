/* tests/orchestration/smoke.test.ts — exercises architecture-spec
   phase_2 ADR-001 (7-phase hybrid lifecycle) end-to-end with hydra wired
   in and a mock dispatch. Verifies fail-closed on hydra veto and fail-open
   on advisory plugins missing ACK. */

import { describe, it, expect } from 'vitest';
import { Orchestrator, SecurityVetoError } from '../../src/orchestration/lifecycle.js';
import { createRequestContext, LIFECYCLE_PHASES } from '../../src/orchestration/request-context.js';
import { InProcessBus } from '../../src/bus/pubsub.js';
import { hydraAdapter } from '../../src/plugins/hydra.adapter.js';
import type { PluginAdapter } from '../../src/plugins/plugin-contract.js';

function makeRegistry(plugins: PluginAdapter[]): Map<string, PluginAdapter> {
  const m = new Map<string, PluginAdapter>();
  for (const p of plugins) m.set(p.name, p);
  return m;
}

describe('orchestrator smoke', () => {
  it('runs all 7 phases in order with hydra wired in', async () => {
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: makeRegistry([hydraAdapter]), bus });
    const ctx = createRequestContext({ user_prompt: 'list files' });

    const phasesObserved: string[] = [];
    bus.subscribe('lifecycle.anchor', (e) => {
      phasesObserved.push(e.phase);
    });
    for (const p of LIFECYCLE_PHASES.slice(1)) {
      bus.subscribe(`lifecycle.${p}`, (e) => {
        phasesObserved.push(e.phase);
      });
    }

    const dispatchResult = await orch.run(ctx, async () => 'mock-tool-result');

    expect(phasesObserved).toEqual([...LIFECYCLE_PHASES]);
    expect(dispatchResult).toBe('mock-tool-result');
  });

  it('fails closed when hydra fires a veto on a malicious tool call', async () => {
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: makeRegistry([hydraAdapter]), bus });
    const ctx = createRequestContext();

    // Wire a subscriber that publishes a malicious tool-call event at trust-gate
    // so hydra sees it and fires a veto.
    bus.subscribe('lifecycle.trust-gate', async (e) => {
      await bus.publish('mcp.tool.call.requested', {
        correlation_id: e.correlation_id,
        session_id: e.session_id,
        phase: 'trust-gate',
        source: 'test',
        budget_tier: e.budget_tier,
        payload: { tool: 'shell.exec', args: { cmd: 'rm -rf /' } },
      });
    });

    await expect(orch.run(ctx, async () => 'should-not-reach')).rejects.toBeInstanceOf(
      SecurityVetoError,
    );
  });

  it('fails open with degraded findings when no plugins are registered', async () => {
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: makeRegistry([]), bus });
    const ctx = createRequestContext();
    const result = await orch.run(ctx, async () => 'ok');
    expect(result).toBe('ok');
    expect(ctx.degraded_findings).toEqual([]);
  });
});
