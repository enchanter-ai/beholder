/* tests/plugins/emu.test.ts — exercises architecture-spec phase_1.emu
   (token economy monitoring + runway forecasting + drift detection).
   Source: plugins/emu/README.md §§ A1, A2; emu.adapter.ts v0.2. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  emuAdapter,
  recordUsage,
  getObservations,
  resetObservations,
  configureEmu,
} from '../../src/plugins/emu.adapter.js';
import { createRequestContext } from '../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEvent(
  phase: 'pre-dispatch' | 'post-response',
  payload: Record<string, unknown> = {},
): EnchantedEvent {
  return {
    id: 'test-event',
    correlation_id: 'corr-001',
    session_id: 'sess-001',
    phase,
    topic: phase === 'post-response' ? 'mcp.tool.result.received' : 'mcp.tool.call.requested',
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetObservations();
  // Reset budget to a predictable value so forecast arithmetic is stable.
  configureEmu({ remaining_budget: 100_000 });
});

// ── Test 1: Cold start — runway returns undefined/no event ───────────────────

describe('cold start', () => {
  it('returns ack with no runway forecast when fewer than 2 observations exist', async () => {
    // 0 observations
    const ctx = createRequestContext();
    let ack = await emuAdapter.onPhase(makeEvent('pre-dispatch'), ctx);
    expect(ack.status).toBe('ack');
    expect((ack.derived_events ?? []).filter((e) => e.topic === 'emu.runway.forecast')).toHaveLength(0);

    // 1 observation (still cold)
    recordUsage(500, 200, 'tool-A');
    ack = await emuAdapter.onPhase(makeEvent('pre-dispatch'), ctx);
    expect(ack.status).toBe('ack');
    expect((ack.derived_events ?? []).filter((e) => e.topic === 'emu.runway.forecast')).toHaveLength(0);
  });
});

// ── Test 2: Runway forecast with finite mean + CI ─────────────────────────────

describe('runway forecast', () => {
  it('emits emu.runway.forecast with finite mean and 95% CI after 10 observations', async () => {
    // Record 10 observations with deterministic token counts.
    for (let i = 0; i < 10; i++) {
      recordUsage(1_000, 500, `tool-${i}`);
    }

    const ctx = createRequestContext();
    const ack = await emuAdapter.onPhase(makeEvent('pre-dispatch'), ctx);

    expect(ack.status).toBe('ack');
    const runwayEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'emu.runway.forecast',
    );
    expect(runwayEvents).toHaveLength(1);

    const payload = runwayEvents[0]!.payload as {
      point_estimate: number;
      ci_lower: number;
      ci_upper: number;
      mean_tokens_per_call: number;
      sigma: number;
      observation_count: number;
    };

    // Each call uses 1500 tokens; budget=100_000 → ~66.7 turns.
    expect(payload.mean_tokens_per_call).toBeCloseTo(1_500, 1);
    expect(payload.point_estimate).toBeCloseTo(100_000 / 1_500, 1);
    // All observations are identical → σ=0 → CI collapses to the point estimate.
    expect(payload.sigma).toBeCloseTo(0, 5);
    expect(payload.ci_lower).toBeGreaterThanOrEqual(0);
    expect(payload.ci_upper).toBeGreaterThanOrEqual(payload.point_estimate);
    expect(payload.observation_count).toBe(10);
  });

});

// ── Test 3: Read-loop drift detection ─────────────────────────────────────────

describe('read-loop drift detection', () => {
  it('emits emu.drift.pattern with pattern_name="read-loop" on 3 identical tool_call_ids', async () => {
    // Post-response handler records the observation from payload.
    const ctx = createRequestContext();
    const makePostResponse = (tool_call_id: string) =>
      makeEvent('post-response', {
        tokens: { input_tokens: 100, output_tokens: 50 },
        tool_call_id,
      });

    await emuAdapter.onPhase(makePostResponse('read-A'), ctx);
    await emuAdapter.onPhase(makePostResponse('read-A'), ctx);
    const ack = await emuAdapter.onPhase(makePostResponse('read-A'), ctx);

    const driftEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'emu.drift.pattern',
    );
    expect(driftEvents).toHaveLength(1);
    expect((driftEvents[0]!.payload as { pattern_name: string }).pattern_name).toBe('read-loop');
  });

});

// ── Test 4: Edit-revert drift detection ───────────────────────────────────────

describe('edit-revert drift detection', () => {
  it('emits emu.drift.pattern with pattern_name="edit-revert" on ABAB tool_call_id sequence', async () => {
    const ctx = createRequestContext();
    const makePostResponse = (tool_call_id: string) =>
      makeEvent('post-response', {
        tokens: { input_tokens: 200, output_tokens: 100 },
        tool_call_id,
      });

    // Seed an A so the window has [A, A, B, A, B] shape at the end —
    // the last 4 must be A,B,A,B for the detector.
    await emuAdapter.onPhase(makePostResponse('edit-A'), ctx);
    await emuAdapter.onPhase(makePostResponse('edit-B'), ctx);
    await emuAdapter.onPhase(makePostResponse('edit-A'), ctx);
    const ack = await emuAdapter.onPhase(makePostResponse('edit-B'), ctx);

    const driftEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'emu.drift.pattern',
    );
    expect(driftEvents).toHaveLength(1);
    expect((driftEvents[0]!.payload as { pattern_name: string }).pattern_name).toBe('edit-revert');
  });

});

// ── Test 5: Window cap at 100 ─────────────────────────────────────────────────

describe('window cap', () => {
  it('evicts oldest observations when window exceeds 100 entries', () => {
    // Record 110 observations; oldest 10 should be gone.
    for (let i = 0; i < 110; i++) {
      recordUsage(i, 0, `tool-${i}`);
    }

    const obs = getObservations();
    expect(obs.length).toBe(100);
    // Oldest surviving observation should be the 11th recorded (i=10).
    expect(obs[0]!.input_tokens).toBe(10);
    // Most recent should be i=109.
    expect(obs[99]!.input_tokens).toBe(109);
  });
});

// ── Test 6: Fail-open ─────────────────────────────────────────────────────────

describe('fail-open', () => {
  it('is not required (advisory) and returns ack on unknown phase', async () => {
    expect(emuAdapter.required).toBe(false);

    const ctx = createRequestContext();
    // dispatch is not in emuAdapter.phases — should still ack gracefully.
    const event: EnchantedEvent = {
      id: 'x',
      correlation_id: 'c',
      session_id: 's',
      phase: 'dispatch',
      topic: 'lifecycle.dispatch',
      source: 'test',
      budget_tier: 'HIGH',
      ts: Date.now(),
      payload: {},
    };
    const ack = await emuAdapter.onPhase(event, ctx);
    expect(ack.status).toBe('ack');
  });
});
