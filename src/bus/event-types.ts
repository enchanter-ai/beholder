/* enchanter/src/bus/event-types.ts — implements architecture-spec
   phase_2 (hybrid coordination, bus surface) + phase_5.cost_attribution_unit.
   The EnchantedEvent shape is the cross-plugin lingua franca. */

import type { LifecyclePhase, BudgetTier } from '../orchestration/request-context.js';

export interface EnchantedEvent {
  readonly id: string;
  readonly correlation_id: string;
  readonly session_id: string;
  readonly phase: LifecyclePhase;
  readonly topic: string;
  readonly source: string; // plugin name or 'orchestrator'
  readonly budget_tier: BudgetTier;
  readonly ts: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** A subscriber to one or more topics. Returns derived events to publish back to the bus. */
export type EventHandler = (event: EnchantedEvent) => Promise<EnchantedEvent[] | void> | EnchantedEvent[] | void;

export interface Subscription {
  readonly topic: string;
  readonly handler: EventHandler;
  unsubscribe(): void;
}

/** ACK tracking for the orchestrator's wait_for_acks(...) primitive. */
export interface PluginAck {
  status: 'ack' | 'veto' | 'error';
  reason?: string;
  derived_events?: EnchantedEvent[];
  /** Advisory plugins set this when they fail-open in a degraded state. */
  degraded?: boolean;
}
