/* tests/plugins/pech.test.ts — v0.2 coverage for pech.adapter.ts.
   Cites: architecture-spec phase_5.budget_thresholds + plugins/pech source. */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  pechAdapter,
  setBudget,
  getLedger,
  getRemainingByVendor,
  clear,
} from '../../src/plugins/pech.adapter.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';
import { createRequestContext } from '../../src/orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EnchantedEvent> & { payload?: Record<string, unknown> }): EnchantedEvent {
  return {
    id: 'test-id',
    correlation_id: 'corr-1',
    session_id: 'sess-1',
    phase: 'post-response',
    topic: 'sampling.completed',
    source: 'test-plugin',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

function makeCtx() {
  return createRequestContext({ session_id: 'sess-1' });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pechAdapter — cold start', () => {
  beforeEach(() => clear());

  it('starts with an empty ledger and emits no threshold events', async () => {
    // No budget configured, no usage — ledger must be empty before any call.
    expect(getLedger()).toHaveLength(0);

    const ack = await pechAdapter.onPhase(makeEvent({}), makeCtx());

    // Appended one ledger entry; no threshold events (no budget registered).
    expect(ack.status).toBe('ack');
    const topics = (ack.derived_events ?? []).map((e) => e.topic);
    expect(topics).toContain('pech.ledger.appended');
    expect(topics).not.toContain('pech.threshold.crossed');
    expect(topics).not.toContain('pech.vendor.exhausted');
    expect(getLedger()).toHaveLength(1);
  });
});

describe('pechAdapter — usage below threshold', () => {
  beforeEach(() => clear());

  it('appends entry but emits no crossing event when usage stays within HIGH tier', async () => {
    setBudget('anthropic', 1000);

    // Use 100 tokens — remaining 900/1000 = 90% = HIGH, still in HIGH.
    const event = makeEvent({
      payload: {
        vendor: 'anthropic',
        model: 'claude-sonnet',
        plugin: 'wixie',
        tokens: { input: 80, output: 20 },
      },
    });

    const ack = await pechAdapter.onPhase(event, makeCtx());

    expect(ack.status).toBe('ack');
    const topics = (ack.derived_events ?? []).map((e) => e.topic);
    expect(topics).toContain('pech.ledger.appended');
    expect(topics).not.toContain('pech.threshold.crossed');
    expect(topics).not.toContain('pech.vendor.exhausted');
    expect(getLedger()).toHaveLength(1);
    expect(getRemainingByVendor('anthropic')).toBe(900);
  });
});

describe('pechAdapter — HIGH → MED boundary crossing', () => {
  beforeEach(() => clear());

  it('emits pech.threshold.crossed with correct old/new tier when usage pushes remaining below 70%', async () => {
    setBudget('anthropic', 1000);

    // First call: consume 350 tokens → remaining 650/1000 = 65% → below HIGH (0.7) → MED.
    const event = makeEvent({
      payload: {
        vendor: 'anthropic',
        model: 'claude-sonnet',
        plugin: 'wixie',
        tokens: { input: 300, output: 50 },
      },
    });

    const ack = await pechAdapter.onPhase(event, makeCtx());

    expect(ack.status).toBe('ack');
    const crossingEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'pech.threshold.crossed',
    );
    expect(crossingEvents).toHaveLength(1);
    const crossing = crossingEvents[0]!;
    expect(crossing.payload['vendor']).toBe('anthropic');
    expect(crossing.payload['old_tier']).toBe('HIGH');
    expect(crossing.payload['new_tier']).toBe('MED');
    expect(typeof crossing.payload['remaining_pct']).toBe('number');
    expect(crossing.payload['remaining_pct'] as number).toBeCloseTo(0.65);
  });
});

describe('pechAdapter — vendor exhausted', () => {
  beforeEach(() => clear());

  it('emits pech.vendor.exhausted when remaining_pct reaches 0', async () => {
    setBudget('openai', 500);

    // Consume exactly 500 tokens.
    const event = makeEvent({
      payload: {
        vendor: 'openai',
        model: 'gpt-4o',
        plugin: 'sylph',
        tokens: { input: 400, output: 100 },
      },
    });

    const ack = await pechAdapter.onPhase(event, makeCtx());

    expect(ack.status).toBe('ack');
    const exhaustedEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'pech.vendor.exhausted',
    );
    expect(exhaustedEvents).toHaveLength(1);
    expect(exhaustedEvents[0]!.payload['vendor']).toBe('openai');
    expect(exhaustedEvents[0]!.payload['remaining_pct']).toBe(0);
    expect(getRemainingByVendor('openai')).toBe(0);
  });
});

describe('pechAdapter — multi-vendor isolation', () => {
  beforeEach(() => clear());

  it('exhausting vendor A does not affect vendor B remaining budget', async () => {
    setBudget('anthropic', 500);
    setBudget('openai', 500);

    // Exhaust openai entirely.
    const openaiEvent = makeEvent({
      payload: {
        vendor: 'openai',
        model: 'gpt-4o',
        plugin: 'emu',
        tokens: { input: 400, output: 100 },
      },
    });
    const ackA = await pechAdapter.onPhase(openaiEvent, makeCtx());
    const exhaustedTopics = (ackA.derived_events ?? []).map((e) => e.topic);
    expect(exhaustedTopics).toContain('pech.vendor.exhausted');

    // anthropic budget must be untouched.
    expect(getRemainingByVendor('anthropic')).toBe(500);
    expect(getRemainingByVendor('openai')).toBe(0);

    // A call attributed to anthropic should not produce an exhausted event.
    const anthropicEvent = makeEvent({
      payload: {
        vendor: 'anthropic',
        model: 'claude-haiku',
        plugin: 'hydra',
        tokens: { input: 10, output: 5 },
      },
    });
    const ackB = await pechAdapter.onPhase(anthropicEvent, makeCtx());
    const bTopics = (ackB.derived_events ?? []).map((e) => e.topic);
    expect(bTopics).not.toContain('pech.vendor.exhausted');
    expect(getRemainingByVendor('anthropic')).toBe(485);
  });
});

describe('pechAdapter — ledger immutability', () => {
  beforeEach(() => clear());

  it('ledger entries are push-only: existing entries are never mutated', async () => {
    setBudget('anthropic', 1000);

    const event1 = makeEvent({
      payload: {
        vendor: 'anthropic',
        model: 'claude-sonnet',
        plugin: 'wixie',
        tokens: { input: 50, output: 10 },
      },
    });
    await pechAdapter.onPhase(event1, makeCtx());

    // Capture a reference to the first entry before the second call.
    const firstEntrySnapshot = { ...getLedger()[0]! };

    const event2 = makeEvent({
      payload: {
        vendor: 'anthropic',
        model: 'claude-haiku',
        plugin: 'pech',
        tokens: { input: 100, output: 20 },
      },
    });
    await pechAdapter.onPhase(event2, makeCtx());

    // Two entries; first entry must be identical to the snapshot.
    expect(getLedger()).toHaveLength(2);
    expect(getLedger()[0]).toStrictEqual(firstEntrySnapshot);
    // Second entry is a different object.
    expect(getLedger()[1]).not.toStrictEqual(firstEntrySnapshot);
  });
});

describe('pechAdapter — contract invariants', () => {
  it('is required (fail-closed)', () => {
    expect(pechAdapter.required).toBe(true);
  });

  it('budget_tier is always', () => {
    expect(pechAdapter.budget_tier).toBe('always');
  });

  it('participates only in post-response phase', () => {
    expect(pechAdapter.phases).toEqual(['post-response']);
  });

  it('returns ack (not veto) for non-post-response phase', async () => {
    const event = makeEvent({ phase: 'trust-gate', topic: 'lifecycle.trust-gate' });
    const ack = await pechAdapter.onPhase(event, makeCtx());
    expect(ack.status).toBe('ack');
    expect(ack.derived_events).toBeUndefined();
  });
});
