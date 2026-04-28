/* tests/plugins/crow.test.ts — verifies architecture-spec phase_1.crow:
   Beta-Binomial posterior + info-gain entropy + review-trigger logic. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  crowAdapter,
  posteriorStore,
  update_posterior,
  posteriorMean,
  observationCount,
  betaEntropy,
} from '../../src/plugins/crow.adapter.js';
import { createRequestContext } from '../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrustGateEvent(tool: string, server_id = 'test-server'): EnchantedEvent {
  return {
    id: 'evt-1',
    correlation_id: 'corr-1',
    session_id: 'sess-1',
    phase: 'trust-gate',
    topic: 'mcp.tool.call.requested',
    source: server_id,
    budget_tier: 'MED',
    ts: Date.now(),
    payload: { tool, server_id },
  };
}

// ---------------------------------------------------------------------------
// Reset posterior store before each test to keep tests independent
// ---------------------------------------------------------------------------
beforeEach(() => {
  posteriorStore.clear();
});

// ---------------------------------------------------------------------------
// Test 1: Uniform prior Beta(1,1) — mean = 0.5, 0 observations
// ---------------------------------------------------------------------------
describe('Test 1: uniform prior', () => {
  it('starts at Beta(1,1) with posterior mean = 0.5 and 0 observations', () => {
    // Force creation by calling update_posterior once then checking the "un-observed" mean.
    // Actually, we verify the un-touched posterior via the adapter emitting no review on
    // cold-start, AND by checking mean+count directly after creating via update path.
    // Simpler: call getOrCreate indirectly via update_posterior(success=true, 0 times).
    // We expose posteriorStore so we can inspect the raw posterior after one ack call.
    const ctx = createRequestContext({ mcp_server_id: 'test-server' });
    const event = makeTrustGateEvent('my_tool');

    // Before any observations — posterior does not exist yet; adapter creates it lazily.
    // After onPhase the cold-start posterior is in the store.
    void crowAdapter.onPhase(event, ctx);

    const p = posteriorStore.get('test-server::my_tool');
    expect(p).toBeDefined();
    expect(p!.alpha).toBe(1);
    expect(p!.beta).toBe(1);
    expect(posteriorMean(p!)).toBeCloseTo(0.5, 10);
    expect(observationCount(p!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: 5 successes → mean > 0.7
// ---------------------------------------------------------------------------
describe('Test 2: 5 successes raise trust above 0.7', () => {
  it('after 5 successes the posterior mean exceeds 0.7', () => {
    for (let i = 0; i < 5; i++) {
      update_posterior('srv', 'tool_a', true);
    }
    // α = 1 + 5 = 6, β = 1  →  mean = 6/7 ≈ 0.857
    const p = posteriorStore.get('srv::tool_a');
    expect(p).toBeDefined();
    expect(posteriorMean(p!)).toBeGreaterThan(0.7);
  });
});

// ---------------------------------------------------------------------------
// Test 3: 5 failures → mean < 0.3 AND triggers crow.review.ordered
// ---------------------------------------------------------------------------
describe('Test 3: 5 failures lower trust and trigger review', () => {
  it('posterior mean < 0.3 after 5 failures', () => {
    for (let i = 0; i < 5; i++) {
      update_posterior('srv', 'risky_tool', false);
    }
    // α = 1, β = 1 + 5 = 6  →  mean = 1/7 ≈ 0.143
    const p = posteriorStore.get('srv::risky_tool');
    expect(p).toBeDefined();
    expect(posteriorMean(p!)).toBeLessThan(0.3);
  });

  it('emits crow.review.ordered in derived_events when mean < 0.5 and n >= 3', async () => {
    for (let i = 0; i < 5; i++) {
      update_posterior('srv', 'risky_tool', false);
    }
    const ctx = createRequestContext({ mcp_server_id: 'srv' });
    const event = makeTrustGateEvent('risky_tool', 'srv');
    const ack = await crowAdapter.onPhase(event, ctx);

    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    expect(ack.derived_events).toBeDefined();
    expect(ack.derived_events!.length).toBeGreaterThanOrEqual(1);
    const reviewEvent = ack.derived_events!.find((e) => e.topic === 'crow.review.ordered');
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent!.payload['tool_name']).toBe('risky_tool');
    expect(reviewEvent!.payload['trust_score'] as number).toBeLessThan(0.3);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Cold start (< 3 observations) does NOT trigger review even if mean < 0.5
// ---------------------------------------------------------------------------
describe('Test 4: cold-start guard', () => {
  it('does not trigger crow.review.ordered with only 2 failures (n=2 < 3)', async () => {
    update_posterior('srv', 'new_tool', false);
    update_posterior('srv', 'new_tool', false);
    // α=1, β=3 → mean=1/4=0.25 < 0.5, but n=2 < 3 → no review

    const ctx = createRequestContext({ mcp_server_id: 'srv' });
    const event = makeTrustGateEvent('new_tool', 'srv');
    const ack = await crowAdapter.onPhase(event, ctx);

    expect(ack.status).toBe('ack');
    const reviewFired = (ack.derived_events ?? []).some((e) => e.topic === 'crow.review.ordered');
    expect(reviewFired).toBe(false);
  });

  it('does not trigger review on a brand-new (0-observation) posterior', async () => {
    // No prior calls to update_posterior — posterior is created lazily by onPhase.
    const ctx = createRequestContext({ mcp_server_id: 'srv' });
    const event = makeTrustGateEvent('fresh_tool', 'srv');
    const ack = await crowAdapter.onPhase(event, ctx);

    expect(ack.status).toBe('ack');
    const reviewFired = (ack.derived_events ?? []).some((e) => e.topic === 'crow.review.ordered');
    expect(reviewFired).toBe(false);
    // degraded flag may or may not be set (mean=0.5, not below threshold)
    // mean=0.5 is NOT < 0.5 so degraded should be false
    expect(ack.degraded).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Test 5: Entropy decreases as observation count increases
// ---------------------------------------------------------------------------
describe('Test 5: entropy decreases with more observations', () => {
  it('entropy after 1 observation is less than at the uniform prior', () => {
    const prior = { alpha: 1, beta: 1 };
    const h0 = betaEntropy(prior);

    update_posterior('srv', 'obs_tool', true);
    const p = posteriorStore.get('srv::obs_tool')!;
    const h1 = betaEntropy(p); // Beta(2,1)

    // More information → lower entropy
    expect(h1).toBeLessThan(h0);
  });

  it('entropy after 10 observations is less than after 1 observation', () => {
    update_posterior('srv', 'obs10', true);
    const p1 = { ...posteriorStore.get('srv::obs10')! };
    const h1 = betaEntropy(p1);

    // 9 more successes
    for (let i = 0; i < 9; i++) {
      update_posterior('srv', 'obs10', true);
    }
    const p10 = posteriorStore.get('srv::obs10')!;
    const h10 = betaEntropy(p10);

    expect(h10).toBeLessThan(h1);
  });
});
