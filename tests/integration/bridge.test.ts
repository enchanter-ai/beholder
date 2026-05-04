/* tests/integration/bridge.test.ts — round-trip test for the TS event
   bridge (src/observability/bridge.ts).

   Publishes a representative set of events through an InProcessBus, lets
   the bridge's FileSink stream them to a tempfile, then asserts:
     1. line count matches publish count
     2. every line is valid JSON
     3. every line carries the required `type` and `time` fields
     4. well-typed variants carry the fields documented in
        docs/event-schema.md

   The fixture at inspector/tests/fixtures/bridge-roundtrip.jsonl is the
   committed Rust-side counterpart; cargo's `bridge_roundtrip` test in
   inspector/tests/fixture_replay.rs proves the Rust parser accepts that
   shape end-to-end. */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InProcessBus } from '../../src/bus/pubsub.js';
import { Bridge, FileSink, serializeEvent, toWireRecord } from '../../src/observability/bridge.js';
import type { EnchantedEvent } from '../../src/bus/event-types.js';

interface PublishInput {
  topic: string;
  source: string;
  phase: EnchantedEvent['phase'];
  payload: Record<string, unknown>;
}

const CANONICAL: PublishInput[] = [
  // Well-typed variants -----------------------------------------------------
  {
    topic: 'runtime.metrics',
    source: 'orchestrator',
    phase: 'dispatch',
    payload: {
      open_sessions: 3,
      ongoing_tasks: 5,
      queued_tasks: 2,
      blocked_tasks: 1,
      code_written_lifetime_loc: 12000,
      code_modified_lifetime_loc: 4500,
      files_created_lifetime: 80,
      files_modified_lifetime: 210,
      tool_calls_lifetime: 9000,
      prs_created_lifetime: 14,
      tests_run_lifetime: 320,
      tests_passed_rate: 0.94,
      total_spend_lifetime: 12.75,
    },
  },
  {
    topic: 'tool.call',
    source: 'tool',
    phase: 'dispatch',
    payload: {
      tool: 'read_file',
      payload: { path: 'src/router.ts', risk: 'low' },
      task_id: 'T-104',
    },
  },
  {
    topic: 'hydra.veto',
    source: 'hydra',
    phase: 'pre-dispatch',
    payload: {
      policy: 'no-secrets',
      reason: 'API key in diff',
      action: 'block',
      severity: 'critical',
      payload: { file: 'src/lib.rs', line: 42 },
      workspace: '/repo',
      env: 'dev',
    },
  },
  {
    topic: 'pech.ledger',
    source: 'pech',
    phase: 'post-response',
    payload: {
      payload: {
        input_tokens: 1200,
        output_tokens: 340,
        cost_usd: 0.012,
        session_cost_usd: 0.45,
        daily_cost_usd: 3.21,
      },
      task_id: 'T-104',
    },
  },
  {
    topic: 'task.updated',
    source: 'orchestrator',
    phase: 'dispatch',
    payload: {
      task_id: 'T-104',
      status: 'running',
      intent: 'refactor parser',
      file_or_area: 'src/event.rs',
      risk: 'low',
      age_seconds: 42,
    },
  },
  {
    topic: 'code.modified',
    source: 'orchestrator',
    phase: 'post-response',
    payload: {
      file: 'src/router.ts',
      language: 'typescript',
      lines_added: 42,
      lines_removed: 11,
      lines_modified: 53,
      task_id: 'T-104',
    },
  },
  // GenericPayload variants -------------------------------------------------
  {
    topic: 'session.started',
    source: 'orchestrator',
    phase: 'anchor',
    payload: {},
  },
  {
    topic: 'phase.entered',
    source: 'orchestrator',
    phase: 'dispatch',
    payload: {},
  },
  {
    topic: 'plugin.loaded',
    source: 'hydra',
    phase: 'anchor',
    payload: {},
  },
  {
    topic: 'sylph.veto',
    source: 'sylph',
    phase: 'trust-gate',
    payload: {
      severity: 'high',
      policy: 'force-push',
      reason: 'force push to protected branch',
      action: 'blocked',
    },
  },
];

async function publishAll(bus: InProcessBus): Promise<void> {
  for (const e of CANONICAL) {
    await bus.publish(e.topic, {
      correlation_id: 'cid-test',
      session_id: 'sess-abc',
      phase: e.phase,
      source: e.source,
      budget_tier: 'MED',
      payload: e.payload,
    });
  }
}

describe('Bridge round-trip', () => {
  it('writes one valid JSONL line per published event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'enchanter-bridge-'));
    const path = join(dir, 'roundtrip.jsonl');
    try {
      const bus = new InProcessBus();
      const sink = new FileSink(path);
      const bridge = new Bridge(bus, sink, {
        onError: () => {
          /* swallow; failures surface via assertions below */
        },
      });
      bridge.start();

      await publishAll(bus);
      await bridge.stop();

      const raw = readFileSync(path, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);

      // 1. Line count matches publish count.
      expect(lines.length).toBe(CANONICAL.length);

      // 2. Every line is valid JSON.
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

      // 3. Every record carries `type` and `time`.
      for (const r of parsed) {
        expect(typeof r.type).toBe('string');
        expect(typeof r.time).toBe('number');
      }

      // 4. Variant-specific shape checks. Records are emitted in CANONICAL
      //    order because the bridge serializes through a single chained
      //    promise (FIFO).
      const byType = new Map<string, Record<string, unknown>>();
      for (const r of parsed) byType.set(r.type as string, r);

      const metrics = byType.get('runtime.metrics');
      expect(metrics).toBeDefined();
      expect(metrics?.open_sessions).toBe(3);
      expect(metrics?.tests_passed_rate).toBe(0.94);

      const toolCall = byType.get('tool.call');
      expect(toolCall).toBeDefined();
      expect(toolCall?.tool).toBe('read_file');
      expect(toolCall?.payload).toEqual({ path: 'src/router.ts', risk: 'low' });
      expect(toolCall?.session_id).toBe('sess-abc');
      expect(toolCall?.phase).toBe('dispatch');

      const veto = byType.get('hydra.veto');
      expect(veto).toBeDefined();
      expect(veto?.severity).toBe('critical');
      expect(veto?.policy).toBe('no-secrets');
      expect(veto?.action).toBe('block');

      const ledger = byType.get('pech.ledger');
      expect(ledger).toBeDefined();
      const ledgerPayload = ledger?.payload as Record<string, unknown>;
      expect(ledgerPayload.input_tokens).toBe(1200);
      expect(ledgerPayload.daily_cost_usd).toBe(3.21);

      const taskUpdated = byType.get('task.updated');
      expect(taskUpdated).toBeDefined();
      expect(taskUpdated?.task_id).toBe('T-104');
      expect(taskUpdated?.session_id).toBe('sess-abc');
      expect(taskUpdated?.age_seconds).toBe(42);

      const codeMod = byType.get('code.modified');
      expect(codeMod).toBeDefined();
      expect(codeMod?.file).toBe('src/router.ts');
      expect(codeMod?.lines_added).toBe(42);

      // 5. Generic variants get session_id + plugin from the envelope.
      const phaseEntered = byType.get('phase.entered');
      expect(phaseEntered?.session_id).toBe('sess-abc');
      expect(phaseEntered?.plugin).toBe('orchestrator');
      expect(phaseEntered?.phase).toBe('dispatch');
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* tempfile cleanup is best-effort */
      }
    }
  });

  it('serializeEvent emits the documented wire shape', () => {
    const event: EnchantedEvent = {
      id: 'id-1',
      correlation_id: 'cid',
      session_id: 'sess-x',
      phase: 'dispatch',
      topic: 'tool.call',
      source: 'tool',
      budget_tier: 'MED',
      ts: 1714435201_100,
      payload: {
        tool: 'read_file',
        payload: { path: 'a.ts', risk: 'low' },
      },
    };
    const wire = toWireRecord(event);
    expect(wire.type).toBe('tool.call');
    expect(wire.time).toBeCloseTo(1714435201.1, 6);
    expect(wire.tool).toBe('read_file');
    expect(wire.session_id).toBe('sess-x');
    expect(wire.phase).toBe('dispatch');
    expect(wire.plugin).toBe('tool');

    const line = serializeEvent(event);
    const reparsed = JSON.parse(line) as Record<string, unknown>;
    expect(reparsed.type).toBe('tool.call');
  });
});
