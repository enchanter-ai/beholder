/* enchanter/src/orchestration/lifecycle.ts — implements architecture-spec
   phase_2 ADR-001 (hybrid coordination, 7-phase orchestrator) +
   phase_5.per_tier_subsystem_activity (advisory plugins fail-open with
   degraded=true; required plugins fail-closed on missing ACK).
   Counter: pure event-bus would have looser coupling but kills per-request
   causality; pure orchestrator centralizes bottleneck risk — the matrix
   in ADR-001 picked hybrid at 25 over orchestrator/bus tied at 22. */

import type { PluginAdapter, PluginRegistry } from '../plugins/plugin-contract.js';
import type { Bus } from '../bus/pubsub.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import {
  DEFAULT_PHASE_TIMEOUTS_MS,
  LIFECYCLE_PHASES,
  type LifecyclePhase,
  type PhaseTimeoutMap,
  type RequestContext,
} from './request-context.js';

export class SecurityVetoError extends Error {
  constructor(
    public readonly plugin: string,
    public readonly phase: LifecyclePhase,
    public readonly reason: string,
  ) {
    super(`security veto from plugin ${plugin} at phase ${phase}: ${reason}`);
    this.name = 'SecurityVetoError';
  }
}

export class PhaseTimeoutError extends Error {
  constructor(
    public readonly phase: LifecyclePhase,
    public readonly missing: ReadonlyArray<string>,
  ) {
    super(`phase ${phase} timed out without ACK from required plugins: ${missing.join(', ')}`);
    this.name = 'PhaseTimeoutError';
  }
}

export interface OrchestratorConfig {
  readonly registry: PluginRegistry;
  readonly bus: Bus;
  readonly timeouts?: PhaseTimeoutMap;
}

export interface DispatchHandler {
  /** The only function permitted to touch external transport. */
  (ctx: RequestContext): Promise<unknown>;
}

export class Orchestrator {
  private readonly registry: PluginRegistry;
  private readonly bus: Bus;
  private readonly timeouts: PhaseTimeoutMap;

  constructor(config: OrchestratorConfig) {
    this.registry = config.registry;
    this.bus = config.bus;
    this.timeouts = config.timeouts ?? DEFAULT_PHASE_TIMEOUTS_MS;
    this.wireSubscriptions();
  }

  /**
   * Run the 7-phase lifecycle. The dispatch handler is the only callback
   * permitted to talk to an external MCP server.
   */
  async run(ctx: RequestContext, dispatch: DispatchHandler): Promise<unknown> {
    let dispatchResult: unknown = undefined;
    for (const phase of LIFECYCLE_PHASES) {
      ctx.phase = phase;
      const phaseEvent = this.buildPhaseEvent(ctx, phase);
      await this.bus.publish(phaseEvent.topic, phaseEvent);

      const subscribers = this.subscribersForPhase(phase);
      const required = subscribers.filter((p) => p.required).map((p) => p.name);
      const advisory = subscribers.filter((p) => !p.required).map((p) => p.name);
      const all = [...required, ...advisory];

      if (all.length > 0) {
        const acks = await this.bus.acks.waitForAcks(
          ctx.correlation_id,
          phase,
          all,
          this.timeouts[phase],
        );

        // Required plugins must ack; missing ack = phase timeout = fail closed.
        const missingRequired = required.filter((p) => !acks.has(p));
        if (missingRequired.length > 0) {
          throw new PhaseTimeoutError(phase, missingRequired);
        }

        // Veto check — any required plugin returning veto fails closed.
        for (const p of required) {
          const a = acks.get(p);
          if (a && a.status === 'veto') {
            throw new SecurityVetoError(p, phase, a.reason ?? 'veto');
          }
        }

        // Advisory plugins fail open — record degraded findings on missing/error.
        for (const p of advisory) {
          const a = acks.get(p);
          if (!a) {
            ctx.degraded_findings = [...ctx.degraded_findings, { plugin: p, reason: 'no-ack-within-timeout' }];
          } else if (a.status === 'error' || a.degraded) {
            ctx.degraded_findings = [...ctx.degraded_findings, { plugin: p, reason: a.reason ?? 'degraded' }];
          }
        }
      }

      // Dispatch is the only phase that calls external transport.
      if (phase === 'dispatch') {
        dispatchResult = await dispatch(ctx);
      }
    }
    return dispatchResult;
  }

  private wireSubscriptions(): void {
    for (const plugin of this.registry.values()) {
      const handler = async (event: EnchantedEvent): Promise<void> => {
        if (!plugin.phases.includes(event.phase)) return;
        // Dedup: if this plugin already acked for (correlation_id, phase),
        // skip — multiple subscribed topics in the same phase would otherwise
        // fire the handler more than once and double-execute side effects
        // (e.g., pech ledger appending twice).
        if (this.bus.acks.has(event.correlation_id, event.phase, plugin.name)) return;
        try {
          const ack = await plugin.onPhase(event, this.contextFromEvent(event));
          this.bus.acks.ack(event.correlation_id, event.phase, plugin.name, ack);
          // Publish each derived event the plugin returned. Without this, plugin
          // emissions like `hydra.veto.fired` / `hydra.secret.masked` /
          // `pech.threshold.crossed` are stored in the ack object but never
          // reach the bus — downstream subscribers (lich, observability) miss
          // them.
          if (ack.derived_events) {
            for (const de of ack.derived_events) {
              await this.bus.publish(de.topic, de);
            }
          }
        } catch (e) {
          const ack: PluginAck = {
            status: 'error',
            reason: (e as Error).message,
            degraded: !plugin.required,
          };
          this.bus.acks.ack(event.correlation_id, event.phase, plugin.name, ack);
        }
      };

      // Subscribe to plugin's declared domain topics PLUS the lifecycle.<phase>
      // event for every phase the plugin participates in. Per architecture-spec
      // ADR-001: "plugins subscribe to phase-named topics on an in-process bus".
      // The lifecycle.<phase> subscription guarantees the handler always fires
      // on a phase the plugin claims to participate in, even when no
      // domain-specific topic was published. Plugins gate their work via
      // event.topic in onPhase. Dedup via Set so a plugin that declares both a
      // domain topic and the lifecycle topic does not get double-wired.
      const topics = new Set<string>([
        ...plugin.topics.subscribes,
        ...plugin.phases.map((p) => `lifecycle.${p}`),
      ]);
      for (const topic of topics) {
        this.bus.subscribe(topic, handler);
      }
    }
  }

  private subscribersForPhase(phase: LifecyclePhase): PluginAdapter[] {
    return [...this.registry.values()].filter((p) => p.phases.includes(phase));
  }

  private buildPhaseEvent(ctx: RequestContext, phase: LifecyclePhase): EnchantedEvent {
    return {
      id: `${ctx.correlation_id}::${phase}`,
      correlation_id: ctx.correlation_id,
      session_id: ctx.session_id,
      phase,
      topic: `lifecycle.${phase}`,
      source: 'orchestrator',
      budget_tier: ctx.budget_tier,
      ts: Date.now(),
      payload: {
        sampling_depth: ctx.sampling_depth,
        deadline_ms: ctx.deadline_ms,
        elapsed_ms: Date.now() - ctx.started_ms,
      },
    };
  }

  private contextFromEvent(event: EnchantedEvent): RequestContext {
    // Plugins receive a read-only view; the orchestrator is the single mutator.
    // For v0.1 we reconstruct minimally — full context propagation is a v0.2
    // follow-up via a shared per-correlation-id context store.
    return {
      correlation_id: event.correlation_id,
      session_id: event.session_id,
      phase: event.phase,
      budget_tier: event.budget_tier,
      sampling_depth: 0,
      deadline_ms: 30_000,
      started_ms: event.ts,
      degraded_findings: [],
    };
  }
}
