/* tests/plugins/sylph.test.ts — verifies architecture-spec phase_1.sylph:
   W5 destructive-op weaver-gate (trust-gate, fail-closed) and W2 Jaccard
   boundary segmentation (post-session, advisory).
   Cites: plugins/sylph README.md § "The Decision-Gate Contract" + § "W2". */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  sylphAdapter,
  recordEdit,
  getOpenClusters,
  DESTRUCTIVE_OP_PATTERNS,
} from '../../src/plugins/sylph.adapter.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTrustGateEvent(payload: Record<string, unknown>): EnchantedEvent {
  return {
    id: 'test-event-1',
    correlation_id: 'corr-1',
    session_id: 'sess-1',
    phase: 'trust-gate',
    topic: 'mcp.tool.call.requested',
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload,
  };
}

function makePostSessionEvent(ts?: number): EnchantedEvent {
  return {
    id: 'test-event-ps',
    correlation_id: 'corr-ps',
    session_id: 'sess-1',
    phase: 'post-session',
    topic: 'lifecycle.post-session',
    source: 'orchestrator',
    budget_tier: 'HIGH',
    ts: ts ?? Date.now(),
    payload: {},
  };
}

/** Return a mock RequestContext (sylph does not consume it). */
const mockCtx = {} as import('../../src/orchestration/request-context.js').RequestContext;

// ---------------------------------------------------------------------------
// Module-level cluster state is shared; reset between tests via a sentinel
// edit that is never near the test edits in time.
// ---------------------------------------------------------------------------

// We cannot easily reset module-level state without exporting a reset fn,
// so each W2 test uses unique file names and far-future timestamps to avoid
// cross-test interference.

// ---------------------------------------------------------------------------
// 1. Safe git command → ack
// ---------------------------------------------------------------------------

describe('W5 trust-gate: safe command', () => {
  it('returns ack for a safe git status command', async () => {
    const event = makeTrustGateEvent({ tool: 'bash', args: { cmd: 'git status' } });
    const ack = await sylphAdapter.onPhase(event, mockCtx);
    expect(ack.status).toBe('ack');
    expect(ack.reason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2. git push --force → veto with sylph-w5
// ---------------------------------------------------------------------------

describe('W5 trust-gate: git push --force', () => {
  it('vetoes git push --force and returns sylph-w5 reason', async () => {
    const event = makeTrustGateEvent({
      tool: 'bash',
      args: { cmd: 'git push origin main --force' },
    });
    const ack = await sylphAdapter.onPhase(event, mockCtx);
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/^sylph-w5:w5-force-push/);
  });
});

// ---------------------------------------------------------------------------
// 3. rm -rf /tmp/foo → veto with sylph-w5
// ---------------------------------------------------------------------------

describe('W5 trust-gate: rm -rf', () => {
  it('vetoes rm -rf and returns sylph-w5 reason', async () => {
    const event = makeTrustGateEvent({
      tool: 'bash',
      args: { cmd: 'rm -rf /tmp/foo' },
    });
    const ack = await sylphAdapter.onPhase(event, mockCtx);
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/^sylph-w5:w5-rm-rf/);
  });
});

// ---------------------------------------------------------------------------
// 4. git reset --hard → veto with sylph-w5
// ---------------------------------------------------------------------------

describe('W5 trust-gate: git reset --hard', () => {
  it('vetoes git reset --hard', async () => {
    const event = makeTrustGateEvent({
      tool: 'bash',
      args: { cmd: 'git reset --hard HEAD~1' },
    });
    const ack = await sylphAdapter.onPhase(event, mockCtx);
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/^sylph-w5:w5-reset-hard/);
  });
});

// ---------------------------------------------------------------------------
// 5. W2: single edit → cluster open
// ---------------------------------------------------------------------------

describe('W2 boundary: single edit', () => {
  it('opens one cluster after a single recordEdit', () => {
    const baseTs = Date.now() + 1_000_000; // far-future to avoid cross-test collision
    recordEdit('src/auth/token.ts', baseTs);
    const open = getOpenClusters();
    const match = open.find((c) => c.files.includes('src/auth/token.ts'));
    expect(match).toBeDefined();
    expect(match!.closed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. W2: two edits same minute, similar filenames → same cluster
// ---------------------------------------------------------------------------

describe('W2 boundary: co-clustering on Jaccard', () => {
  it('groups two edits with similar names within 5 minutes into one cluster', () => {
    const base = Date.now() + 2_000_000; // different offset from test 5
    recordEdit('src/feature/widget.ts', base);
    recordEdit('src/feature/widget.test.ts', base + 30_000); // 30 s later

    const open = getOpenClusters();
    // Both files should appear in the same cluster.
    const cluster = open.find(
      (c) => c.files.includes('src/feature/widget.ts') && c.files.includes('src/feature/widget.test.ts'),
    );
    expect(cluster).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 7. W2: gap > 10 min → cluster closed, sylph.boundary.closed event emitted
// ---------------------------------------------------------------------------

describe('W2 boundary: idle closure', () => {
  it('closes a cluster and emits sylph.boundary.closed when idle > 10 min', async () => {
    const clusterStart = Date.now() + 3_000_000; // unique offset
    recordEdit('lib/parser/csv.ts', clusterStart);

    // Post-session event arrives 11 minutes after the last edit.
    const postSessionTs = clusterStart + 11 * 60 * 1000;
    const event = makePostSessionEvent(postSessionTs);
    const ack = await sylphAdapter.onPhase(event, mockCtx);

    expect(ack.status).toBe('ack');
    // At least one derived event for sylph.boundary.closed.
    const boundaryEvents = (ack.derived_events ?? []).filter(
      (e) => e.topic === 'sylph.boundary.closed',
    );
    expect(boundaryEvents.length).toBeGreaterThanOrEqual(1);

    // The closed cluster should contain our file.
    const matchingEvent = boundaryEvents.find((e) =>
      (e.payload.files as string[]).includes('lib/parser/csv.ts'),
    );
    expect(matchingEvent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Pattern table sanity: 5+ entries, each with a regex that is a RegExp
// ---------------------------------------------------------------------------

describe('W5 pattern table integrity', () => {
  it('has at least 5 entries and each has a valid regex', () => {
    expect(DESTRUCTIVE_OP_PATTERNS.length).toBeGreaterThanOrEqual(5);
    for (const p of DESTRUCTIVE_OP_PATTERNS) {
      expect(p.id).toBeTruthy();
      expect(p.regex).toBeInstanceOf(RegExp);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Adapter contract: required=true, phases include trust-gate + post-session
// ---------------------------------------------------------------------------

describe('sylphAdapter contract', () => {
  it('is required (fail-closed) and participates in trust-gate + post-session', () => {
    expect(sylphAdapter.required).toBe(true);
    expect(sylphAdapter.phases).toContain('trust-gate');
    expect(sylphAdapter.phases).toContain('post-session');
  });
});
