/* tests/plugins/djinn.test.ts — regression suite for djinn.adapter v0.2.
   Implements architecture-spec phase_1.djinn: intent anchoring + LCS drift
   detection at anchor + post-session phases.
   Draws from plugins/djinn source: shared/scripts/engines/c1_lcs.py (D1 LCS)
   and plugins/intent-anchor (per-session anchor immutability contract). */

import { describe, it, expect, beforeEach } from 'vitest';
import { djinnAdapter, getAnchor, clearAnchor } from '../../src/plugins/djinn.adapter.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _seq = 0;
function makeEvent(
  overrides: Partial<EnchantedEvent> & { phase: EnchantedEvent['phase'] },
): EnchantedEvent {
  _seq += 1;
  return {
    id: `test-${_seq}`,
    correlation_id: `corr-${_seq}`,
    session_id: 'session-default',
    topic: `lifecycle.${overrides.phase}`,
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload: {},
    ...overrides,
  };
}

// Minimal RequestContext stub — djinn does not use ctx in v0.2.
const CTX = {
  correlation_id: 'ctx-corr',
  session_id: 'session-default',
  phase: 'anchor' as const,
  budget_tier: 'HIGH' as const,
  sampling_depth: 0,
  deadline_ms: 30_000,
  started_ms: Date.now(),
  degraded_findings: [],
};

// ---------------------------------------------------------------------------
// Setup: clear anchors before every test to ensure isolation.
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearAnchor('session-a');
  clearAnchor('session-b');
  clearAnchor('session-default');
});

// ---------------------------------------------------------------------------
// Test 1: Anchor is set on the first prompt of a session.
// ---------------------------------------------------------------------------

describe('djinn anchor phase', () => {
  it('sets anchor on first prompt of a new session', async () => {
    const prompt = 'Add dark-mode support with a11y keyboard-trap tests';
    const event = makeEvent({
      session_id: 'session-a',
      phase: 'anchor',
      payload: { user_prompt: prompt },
    });

    const ack = await djinnAdapter.onPhase(event, { ...CTX, session_id: 'session-a' });

    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBeUndefined();

    const anchor = getAnchor('session-a');
    expect(anchor).toBeDefined();
    expect(anchor!.intent).toBe(prompt);
    expect(anchor!.tokens.length).toBeGreaterThan(0);

    // derived_events must include djinn.anchor.set
    expect(ack.derived_events).toHaveLength(1);
    expect(ack.derived_events![0]!.topic).toBe('djinn.anchor.set');
  });

  // -------------------------------------------------------------------------
  // Test 2: Anchor does NOT change on a second prompt of the same session.
  // -------------------------------------------------------------------------

  it('does not change anchor on subsequent prompts for the same session', async () => {
    const firstPrompt = 'Implement the login form with validation';
    const secondPrompt = 'Now add a password-strength meter';

    const firstEvent = makeEvent({
      session_id: 'session-a',
      phase: 'anchor',
      payload: { user_prompt: firstPrompt },
    });
    const secondEvent = makeEvent({
      session_id: 'session-a',
      phase: 'anchor',
      payload: { user_prompt: secondPrompt },
    });

    await djinnAdapter.onPhase(firstEvent, { ...CTX, session_id: 'session-a' });
    const ackSecond = await djinnAdapter.onPhase(secondEvent, { ...CTX, session_id: 'session-a' });

    // Second call should ack quietly — no derived events.
    expect(ackSecond.status).toBe('ack');
    expect(ackSecond.derived_events).toBeUndefined();

    // Anchor still holds the first prompt.
    const anchor = getAnchor('session-a');
    expect(anchor!.intent).toBe(firstPrompt);
  });
});

// ---------------------------------------------------------------------------
// Test 3: LCS-similar prompt does NOT trigger drift.
// ---------------------------------------------------------------------------

describe('djinn post-session drift detection', () => {
  it('does not emit djinn.drift.detected when current prompt is similar to anchor', async () => {
    const anchorPrompt = 'Refactor the database connection pool to use async await';
    const similarPrompt = 'Refactor the database connection to async await patterns';

    // Set anchor
    await djinnAdapter.onPhase(
      makeEvent({ session_id: 'session-a', phase: 'anchor', payload: { user_prompt: anchorPrompt } }),
      { ...CTX, session_id: 'session-a' },
    );

    // Post-session with similar prompt
    const ack = await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'session-a',
        phase: 'post-session',
        payload: { user_prompt: similarPrompt },
      }),
      { ...CTX, session_id: 'session-a', phase: 'post-session' },
    );

    expect(ack.status).toBe('ack');
    // No drift event expected
    const driftEvents = (ack.derived_events ?? []).filter((e) => e.topic === 'djinn.drift.detected');
    expect(driftEvents).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 4: Completely different prompt triggers djinn.drift.detected.
  // -------------------------------------------------------------------------

  it('emits djinn.drift.detected when current prompt diverges far from anchor', async () => {
    const anchorPrompt = 'Add dark-mode support with a11y keyboard-trap tests';
    // Completely unrelated prompt — nearly zero token overlap.
    const driftedPrompt = 'Configure the CI pipeline to deploy the docker container on merge';

    // Set anchor
    await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'session-a',
        phase: 'anchor',
        payload: { user_prompt: anchorPrompt },
      }),
      { ...CTX, session_id: 'session-a' },
    );

    // Post-session with drifted prompt
    const ack = await djinnAdapter.onPhase(
      makeEvent({
        session_id: 'session-a',
        phase: 'post-session',
        payload: { user_prompt: driftedPrompt },
      }),
      { ...CTX, session_id: 'session-a', phase: 'post-session' },
    );

    expect(ack.status).toBe('ack');
    const driftEvents = (ack.derived_events ?? []).filter((e) => e.topic === 'djinn.drift.detected');
    expect(driftEvents).toHaveLength(1);

    const payload = driftEvents[0]!.payload;
    expect(typeof payload['lcs_ratio']).toBe('number');
    expect(payload['lcs_ratio'] as number).toBeLessThan(0.3);
  });

  // -------------------------------------------------------------------------
  // Test 5: Different session_id has an independent anchor.
  // -------------------------------------------------------------------------

  it('maintains independent anchors per session_id', async () => {
    const intentA = 'Fix the SQL injection vulnerability in the user registration endpoint';
    const intentB = 'Write unit tests for the payment module';

    // Set anchor for session-a
    await djinnAdapter.onPhase(
      makeEvent({ session_id: 'session-a', phase: 'anchor', payload: { user_prompt: intentA } }),
      { ...CTX, session_id: 'session-a' },
    );

    // Set anchor for session-b
    await djinnAdapter.onPhase(
      makeEvent({ session_id: 'session-b', phase: 'anchor', payload: { user_prompt: intentB } }),
      { ...CTX, session_id: 'session-b' },
    );

    const anchorA = getAnchor('session-a');
    const anchorB = getAnchor('session-b');

    expect(anchorA).toBeDefined();
    expect(anchorB).toBeDefined();
    expect(anchorA!.intent).toBe(intentA);
    expect(anchorB!.intent).toBe(intentB);
    expect(anchorA!.intent).not.toBe(anchorB!.intent);

    // Second prompt on session-a must not affect session-b's anchor.
    await djinnAdapter.onPhase(
      makeEvent({ session_id: 'session-a', phase: 'anchor', payload: { user_prompt: intentB } }),
      { ...CTX, session_id: 'session-a' },
    );
    expect(getAnchor('session-a')!.intent).toBe(intentA); // unchanged
    expect(getAnchor('session-b')!.intent).toBe(intentB); // still original
  });
});
