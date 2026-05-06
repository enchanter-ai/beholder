/* tests/integration/control-channel.test.ts — round-trip approve/veto via
 * paired in-memory TCP sockets (v0.5 #4 bidirectional control channel).
 *
 * Stands up a local listening socket, opens a TcpControlSink connected to it,
 * and on the listener side simulates the inspector by reading the
 * `request.approval` line and writing back an `approval.response`. Asserts
 * the orchestrator's trust-gate await resolves with the expected verdict for
 * both the approve and veto paths and that timeout fails closed (veto). */

import { describe, it, expect } from 'vitest';
import * as net from 'node:net';

import {
  TcpControlSink,
} from '../../src/observability/bridge.js';
import {
  ControlDispatcher,
  parseControlLine,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ControlChannel,
} from '../../src/observability/control-protocol.js';

interface PairedChannel {
  client: TcpControlSink;
  server: net.Socket;
  close: () => Promise<void>;
}

/** Stand up a localhost listener, accept one connection, return the
 *  TcpControlSink (client side) and the server-side socket (test harness
 *  side). The harness uses `server.write` to feed inbound lines. */
async function makePairedChannel(): Promise<PairedChannel> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) {
    server.close();
    throw new Error('no server address');
  }
  // Wait for both sides to be live before constructing the sink.
  const [clientSock, serverSock] = await Promise.all<net.Socket>([
    new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: addr.port });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    }),
    new Promise((resolve) => {
      server.once('connection', (s) => {
        s.setEncoding('utf8');
        resolve(s);
      });
    }),
  ]);

  const client = TcpControlSink.fromSocket(clientSock);
  return {
    client,
    server: serverSock,
    close: async () => {
      try { serverSock.destroy(); } catch { /* noop */ }
      try { clientSock.destroy(); } catch { /* noop */ }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('control channel — approve/veto round-trip', () => {
  it('approves: inspector responds approve → awaitDecision resolves', async () => {
    const ch = await makePairedChannel();
    try {
      const cid = 'cid-approve-1';

      // Set up server-side listener BEFORE writing so no early data is dropped.
      const inboundP = new Promise<string>((resolve) => {
        let buf = '';
        ch.server.on('data', (chunk: string | Buffer) => {
          buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
          const nl = buf.indexOf('\n');
          if (nl !== -1) resolve(buf.slice(0, nl));
        });
      });

      // Client (runtime) emits the request, then awaits.
      const sendP = ch.client.sendRequestApproval({
        correlation_id: cid,
        plugin: 'trust-pin',
        reason: 'schema digest mismatch',
        phase: 'trust-gate',
        payload: { tool: 'read_file' },
      });
      if (sendP instanceof Promise) await sendP;

      const decisionP = ch.client.awaitDecision(cid, 1000);

      const inbound = [await inboundP];
      expect(inbound.length).toBeGreaterThan(0);
      const req = JSON.parse(inbound[0] as string) as Record<string, unknown>;
      expect(req.type).toBe('request.approval');
      expect(req.correlation_id).toBe(cid);
      expect(req.plugin).toBe('trust-pin');
      expect(req.reason).toBe('schema digest mismatch');

      // Server writes the response back.
      ch.server.write(
        JSON.stringify({
          kind: 'control.command',
          command: 'approval.response',
          correlation_id: cid,
          decision: 'approve',
        }) + '\n',
      );

      const decision = await decisionP;
      expect(decision.decision).toBe('approve');
      expect(decision.correlation_id).toBe(cid);
    } finally {
      await ch.client.end();
      await ch.close();
    }
  });

  it('vetoes: inspector responds veto → awaitDecision resolves with veto', async () => {
    const ch = await makePairedChannel();
    try {
      const cid = 'cid-veto-2';
      const drainP = new Promise<void>((resolve) => {
        ch.server.once('data', () => resolve());
      });
      const sendP = ch.client.sendRequestApproval({
        correlation_id: cid,
        plugin: 'trust-pin',
        reason: 'unknown tool',
        phase: 'trust-gate',
      });
      if (sendP instanceof Promise) await sendP;

      const decisionP = ch.client.awaitDecision(cid, 1000);

      // Drain the request and respond with veto.
      await drainP;
      ch.server.write(
        JSON.stringify({
          kind: 'control.command',
          command: 'approval.response',
          correlation_id: cid,
          decision: 'veto',
          reason: 'human says no',
        }) + '\n',
      );

      const decision = await decisionP;
      expect(decision.decision).toBe('veto');
      expect(decision.reason).toBe('human says no');
    } finally {
      await ch.client.end();
      await ch.close();
    }
  });

  it('times out (fail-closed): no inspector response → reject with timeout', async () => {
    const ch = await makePairedChannel();
    try {
      const cid = 'cid-timeout-3';
      const drainP = new Promise<void>((resolve) => {
        ch.server.once('data', () => resolve());
      });
      const sendP = ch.client.sendRequestApproval({
        correlation_id: cid,
        plugin: 'trust-pin',
        reason: 'no inspector connected',
        phase: 'trust-gate',
      });
      if (sendP instanceof Promise) await sendP;
      // Drain request side; never respond.
      await drainP;

      await expect(ch.client.awaitDecision(cid, 50)).rejects.toThrow(/timeout/i);
    } finally {
      await ch.client.end();
      await ch.close();
    }
  });
});

describe('control protocol — parser', () => {
  it('parseControlLine accepts a well-formed approval.response', () => {
    const cmd = parseControlLine(
      JSON.stringify({
        kind: 'control.command',
        command: 'approval.response',
        correlation_id: 'cid-1',
        decision: 'approve',
      }),
    );
    expect(cmd?.command).toBe('approval.response');
    expect(cmd?.decision).toBe('approve');
  });

  it('parseControlLine rejects unknown decision strings', () => {
    const cmd = parseControlLine(
      JSON.stringify({
        kind: 'control.command',
        command: 'approval.response',
        correlation_id: 'cid-1',
        decision: 'maybe',
      }),
    );
    expect(cmd).toBeNull();
  });

  it('ControlDispatcher resolves a registered wait', async () => {
    const d = new ControlDispatcher();
    const p = d.awaitDecision('cid-x', 1000);
    const ok = d.dispatch(
      JSON.stringify({
        kind: 'control.command',
        command: 'approval.response',
        correlation_id: 'cid-x',
        decision: 'approve',
      }),
    );
    expect(ok).toBe(true);
    const r = await p;
    expect(r.decision).toBe('approve');
  });
});

describe('control channel — orchestrator integration (in-memory)', () => {
  // A minimal in-memory ControlChannel stub: lets us drive Orchestrator.run
  // without spinning up a real TCP socket. Mirrors the contract used by
  // TcpControlSink so the orchestrator path is truly exercised.
  class StubChannel implements ControlChannel {
    private readonly d = new ControlDispatcher();
    public sent: Array<{ correlation_id: string; reason: string }> = [];
    sendRequestApproval(req: { correlation_id: string; plugin: string; reason: string; phase: string }): void {
      this.sent.push({ correlation_id: req.correlation_id, reason: req.reason });
    }
    awaitDecision(cid: string, timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS) {
      return this.d.awaitDecision(cid, timeoutMs);
    }
    respond(cid: string, decision: 'approve' | 'veto', reason?: string): void {
      const obj: Record<string, unknown> = {
        kind: 'control.command',
        command: 'approval.response',
        correlation_id: cid,
        decision,
      };
      if (reason !== undefined) obj.reason = reason;
      this.d.dispatch(JSON.stringify(obj));
    }
  }

  it('orchestrator gates trust-gate on the approval response (approve)', async () => {
    const { Orchestrator } = await import('../../src/orchestration/lifecycle.js');
    const { InProcessBus } = await import('../../src/bus/pubsub.js');
    const { createRequestContext } = await import('../../src/orchestration/request-context.js');

    const channel = new StubChannel();
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: new Map(), bus });
    const ctx = createRequestContext({ mcp_server_id: 'srv', tool_call_id: 'echo' });

    const runP = orch.run(
      ctx,
      async () => 'dispatched',
      {
        controlChannel: channel,
        approvalTimeoutMs: 2000,
        approvalRequest: { plugin: 'trust-pin', reason: 'test approve' },
      },
    );

    // Wait a tick for the orchestrator to reach the await.
    await new Promise((r) => setTimeout(r, 10));
    expect(channel.sent.length).toBe(1);
    expect(channel.sent[0]?.correlation_id).toBe(ctx.correlation_id);
    channel.respond(ctx.correlation_id, 'approve');

    const result = await runP;
    expect(result).toBe('dispatched');
  });

  it('orchestrator throws SecurityVetoError when inspector vetoes', async () => {
    const { Orchestrator, SecurityVetoError } = await import('../../src/orchestration/lifecycle.js');
    const { InProcessBus } = await import('../../src/bus/pubsub.js');
    const { createRequestContext } = await import('../../src/orchestration/request-context.js');

    const channel = new StubChannel();
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: new Map(), bus });
    const ctx = createRequestContext({ mcp_server_id: 'srv', tool_call_id: 'echo' });

    const runP = orch.run(
      ctx,
      async () => 'should not happen',
      {
        controlChannel: channel,
        approvalTimeoutMs: 2000,
        approvalRequest: { plugin: 'trust-pin', reason: 'test veto' },
      },
    );

    await new Promise((r) => setTimeout(r, 10));
    channel.respond(ctx.correlation_id, 'veto', 'human says no');

    await expect(runP).rejects.toThrow(SecurityVetoError);
  });

  it('orchestrator fails closed on approval timeout', async () => {
    const { Orchestrator, SecurityVetoError } = await import('../../src/orchestration/lifecycle.js');
    const { InProcessBus } = await import('../../src/bus/pubsub.js');
    const { createRequestContext } = await import('../../src/orchestration/request-context.js');

    const channel = new StubChannel();
    const bus = new InProcessBus();
    const orch = new Orchestrator({ registry: new Map(), bus });
    const ctx = createRequestContext({ mcp_server_id: 'srv', tool_call_id: 'echo' });

    await expect(
      orch.run(
        ctx,
        async () => 'should not happen',
        {
          controlChannel: channel,
          approvalTimeoutMs: 30,
          approvalRequest: { plugin: 'trust-pin', reason: 'no response' },
        },
      ),
    ).rejects.toThrow(SecurityVetoError);
  });
});
