/* tests/security/hydra-args-array.test.ts — verifies the audit-driven fix
   for hydra's CVE-pattern matching against tool calls whose args arrive as
   a JSON array of strings rather than a single command-line string. */

import { describe, it, expect, beforeEach } from 'vitest';
import { hydraAdapter } from '../../src/plugins/hydra.adapter.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';
import { createRequestContext } from '../../src/orchestration/request-context.js';

function makeTrustGateEvent(payload: Record<string, unknown>): EnchantedEvent {
  return {
    id: 'test-id',
    correlation_id: 'cid',
    session_id: 'sid',
    phase: 'trust-gate',
    topic: 'mcp.tool.call.requested',
    source: 'test',
    budget_tier: 'HIGH',
    ts: Date.now(),
    payload,
  };
}

describe('hydra: CVE matching against args-array shape', () => {
  beforeEach(() => {
    // No persistent state to reset; hydra is stateless in v0.1.
  });

  it('vetoes rm -rf / when args is a single string', async () => {
    const event = makeTrustGateEvent({ tool: 'shell.exec', args: 'rm -rf /' });
    const ack = await hydraAdapter.onPhase(event, createRequestContext());
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/h-rm-rf-root/);
  });

  it('vetoes rm -rf / when args arrives as a JSON array', async () => {
    const event = makeTrustGateEvent({ tool: 'shell.exec', args: ['rm', '-rf', '/'] });
    const ack = await hydraAdapter.onPhase(event, createRequestContext());
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/h-rm-rf-root/);
  });

  it('vetoes ssh-key exfil when args arrives as an array', async () => {
    const event = makeTrustGateEvent({
      tool: 'shell.exec',
      args: ['cat', '~/.ssh/id_rsa'],
    });
    const ack = await hydraAdapter.onPhase(event, createRequestContext());
    expect(ack.status).toBe('veto');
    expect(ack.reason).toMatch(/h-ssh-key-exfil/);
  });

  it('does not veto a benign array call', async () => {
    const event = makeTrustGateEvent({
      tool: 'shell.exec',
      args: ['ls', '-la', '/tmp/foo'],
    });
    const ack = await hydraAdapter.onPhase(event, createRequestContext());
    expect(ack.status).toBe('ack');
  });

  it('handles non-array args gracefully (no crash)', async () => {
    const event = makeTrustGateEvent({ tool: 'shell.exec', args: { unusual: 'shape' } });
    const ack = await hydraAdapter.onPhase(event, createRequestContext());
    // Object args don't get reconstructed; only the JSON string corpus is scanned.
    // No CVE pattern matches the JSON-stringified object, so ack.
    expect(ack.status).toBe('ack');
  });
});
