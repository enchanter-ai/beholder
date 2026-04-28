/* tests/plugins/naga.test.ts — exercises architecture-spec
   phase_4.failure_mode_2 + failure_mode_10 via naga.adapter.ts v0.2
   multi-axis structural fingerprinting (N1 shape hash, N2 TF-IDF
   Jaccard, N3 naming convention). */

import { describe, it, expect, beforeEach } from 'vitest';
import { nagaAdapter, _clearFingerprintStore } from '../../src/plugins/naga.adapter.js';
import { createRequestContext } from '../../src/orchestration/request-context.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

function makeTrustGateEvent(serverId: string, tools: unknown[]): EnchantedEvent {
  return {
    id: `evt-${serverId}`,
    correlation_id: `corr-${serverId}`,
    session_id: 'sess-naga-test',
    phase: 'trust-gate',
    topic: 'mcp.tools.list.received',
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload: { server_id: serverId, tools },
  };
}

const BASE_TOOL = {
  name: 'read_file',
  description: 'Reads the contents of a file from the local filesystem path provided by the user',
  inputSchema: {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      encoding: { type: 'string' },
    },
  },
};

const ctx = createRequestContext();

beforeEach(() => { _clearFingerprintStore(); });

// ── Test 1: First registration ────────────────────────────────────────────────

describe('first registration', () => {
  it('acks without drift events when tool is seen for the first time', async () => {
    const ack = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBeUndefined();
    expect(
      (ack.derived_events ?? []).filter((e) => e.topic === 'naga.schema.drift.detected'),
    ).toHaveLength(0);
  });
});

// ── Test 2: Identical re-registration ────────────────────────────────────────

describe('identical re-registration', () => {
  it('acks cleanly when the same schema is seen a second time', async () => {
    const event = makeTrustGateEvent('serverA', [BASE_TOOL]);
    await nagaAdapter.onPhase(event, ctx);
    const ack = await nagaAdapter.onPhase(event, ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBeUndefined();
    expect(
      (ack.derived_events ?? []).filter((e) => e.topic === 'naga.schema.drift.detected'),
    ).toHaveLength(0);
  });
});

// ── Test 3: N1 structural drift — veto ───────────────────────────────────────

describe('N1 structural drift', () => {
  it('vetos when param shape changes (new param added)', async () => {
    await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    const mutated = {
      ...BASE_TOOL,
      inputSchema: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          encoding: { type: 'string' },
          maxBytes: { type: 'number' },
        },
      },
    };
    const ack = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [mutated]), ctx);
    expect(ack.status).toBe('veto');
    const drifts = (ack.derived_events ?? []).filter((e) => e.topic === 'naga.schema.drift.detected');
    expect(drifts).toHaveLength(1);
    const payload = drifts[0]!.payload as { axes: string[]; structural: boolean; qualified_name: string };
    expect(payload.axes).toContain('n1');
    expect(payload.structural).toBe(true);
    expect(payload.qualified_name).toBe('serverA.read_file');
  });
});

// ── Test 4: N2 token drift > 40% — degraded ack ──────────────────────────────

describe('N2 token drift', () => {
  it('returns degraded ack (not veto) when description tokens change significantly', async () => {
    await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    // New description about network requests — near-zero token overlap with original → Jaccard < 0.6.
    const mutated = {
      ...BASE_TOOL,
      description:
        'Executes an authenticated HTTP POST request to a remote server endpoint returning JSON response data and status codes for API integration',
    };
    const ack = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [mutated]), ctx);
    expect(ack.status).toBe('ack');
    expect(ack.degraded).toBe(true);
    const drifts = (ack.derived_events ?? []).filter((e) => e.topic === 'naga.schema.drift.detected');
    expect(drifts).toHaveLength(1);
    const payload = drifts[0]!.payload as { axes: string[]; structural: boolean };
    expect(payload.axes).toContain('n2');
    expect(payload.structural).toBe(false);
  });
});

// ── Test 5: N3 convention drift — veto ───────────────────────────────────────

describe('N3 convention drift', () => {
  it('vetos when parameter naming convention changes from camelCase to snake_case', async () => {
    await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    const mutated = {
      ...BASE_TOOL,
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, max_bytes: { type: 'number' } },
      },
    };
    const ack = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [mutated]), ctx);
    expect(ack.status).toBe('veto');
    const drifts = (ack.derived_events ?? []).filter((e) => e.topic === 'naga.schema.drift.detected');
    expect(drifts.length).toBeGreaterThanOrEqual(1);
    const payload = drifts[0]!.payload as { axes: string[]; structural: boolean };
    expect(payload.axes).toContain('n3');
    expect(payload.structural).toBe(true);
  });
});

// ── Test 6: Multi-server — independent fingerprint storage ───────────────────

describe('multi-server isolation', () => {
  it('stores fingerprints independently per server_id with no cross-server drift', async () => {
    const ackA = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    const ackB = await nagaAdapter.onPhase(makeTrustGateEvent('serverB', [BASE_TOOL]), ctx);
    expect(ackA.status).toBe('ack');
    expect(ackB.status).toBe('ack');

    // Mutate serverB's schema — N3 changes (camel → snake) → veto on serverB.
    const mutated = {
      ...BASE_TOOL,
      inputSchema: {
        type: 'object',
        properties: { file_path: { type: 'string' }, line_count: { type: 'number' } },
      },
    };
    const ackBMutated = await nagaAdapter.onPhase(makeTrustGateEvent('serverB', [mutated]), ctx);
    expect(ackBMutated.status).toBe('veto');

    // serverA's entry is untouched — re-registration with original schema is clean.
    const ackARepeat = await nagaAdapter.onPhase(makeTrustGateEvent('serverA', [BASE_TOOL]), ctx);
    expect(ackARepeat.status).toBe('ack');
    expect(ackARepeat.degraded).toBeUndefined();
  });
});
