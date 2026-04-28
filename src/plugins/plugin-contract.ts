/* enchanter/src/plugins/plugin-contract.ts — implements architecture-spec
   phase_1_plugin_role_mapping (the 10-plugin contract) + ADR-001 fail-open vs
   fail-closed policy. Every plugin adapter implements PluginAdapter. */

import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { LifecyclePhase, RequestContext } from '../orchestration/request-context.js';

export type BudgetTierGate = 'always' | 'med-or-higher' | 'high-only';

export interface PluginAdapter {
  readonly name: string;
  /** lifecycle phases this plugin participates in */
  readonly phases: ReadonlyArray<LifecyclePhase>;
  /** if true, orchestrator fail-closed on missing ACK; if false, fail-open with degraded=true */
  readonly required: boolean;
  readonly topics: {
    readonly subscribes: ReadonlyArray<string>;
    readonly emits: ReadonlyArray<string>;
  };
  readonly budget_tier: BudgetTierGate;
  /** Called by the orchestrator at each subscribed phase. Must return within phase timeout. */
  onPhase(event: EnchantedEvent, ctx: RequestContext): Promise<PluginAck>;
}

export type PluginRegistry = ReadonlyMap<string, PluginAdapter>;
