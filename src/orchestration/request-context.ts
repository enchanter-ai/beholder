/* enchanter/src/orchestration/request-context.ts — implements architecture-spec
   phase_2_coordination_pattern_decision.adr (ADR-001, hybrid orchestrator)
   and phase_5.cost_attribution_unit. Every request carries a correlation_id
   stamped at orchestrator entry; every bus emission propagates it. */

import { randomUUID } from 'node:crypto';

export type LifecyclePhase =
  | 'anchor'
  | 'trust-gate'
  | 'pre-dispatch'
  | 'dispatch'
  | 'post-response'
  | 'post-session'
  | 'cross-session';

export type BudgetTier = 'HIGH' | 'MED' | 'LOW' | 'CRITICAL';

export const LIFECYCLE_PHASES: ReadonlyArray<LifecyclePhase> = [
  'anchor',
  'trust-gate',
  'pre-dispatch',
  'dispatch',
  'post-response',
  'post-session',
  'cross-session',
];

export interface RequestContext {
  readonly correlation_id: string;
  readonly session_id: string;
  phase: LifecyclePhase;
  budget_tier: BudgetTier;
  readonly user_prompt?: string;
  readonly mcp_server_id?: string;
  readonly tool_call_id?: string;
  sampling_depth: number;
  readonly deadline_ms: number;
  readonly started_ms: number;
  /** advisory plugins set this when they ack with degraded=true */
  degraded_findings: ReadonlyArray<{ plugin: string; reason: string }>;
}

export interface RequestContextInit {
  session_id?: string;
  budget_tier?: BudgetTier;
  user_prompt?: string;
  mcp_server_id?: string;
  tool_call_id?: string;
  deadline_ms?: number;
}

export function createRequestContext(init: RequestContextInit = {}): RequestContext {
  return {
    correlation_id: randomUUID(),
    session_id: init.session_id ?? randomUUID(),
    phase: 'anchor',
    budget_tier: init.budget_tier ?? 'HIGH',
    user_prompt: init.user_prompt,
    mcp_server_id: init.mcp_server_id,
    tool_call_id: init.tool_call_id,
    sampling_depth: 0,
    deadline_ms: init.deadline_ms ?? 30_000,
    started_ms: Date.now(),
    degraded_findings: [],
  };
}

export interface PhaseTimeoutMap {
  readonly anchor: number;
  readonly 'trust-gate': number;
  readonly 'pre-dispatch': number;
  readonly dispatch: number;
  readonly 'post-response': number;
  readonly 'post-session': number;
  readonly 'cross-session': number;
}

export const DEFAULT_PHASE_TIMEOUTS_MS: PhaseTimeoutMap = {
  anchor: 200,
  'trust-gate': 500,
  'pre-dispatch': 200,
  dispatch: 10_000, // generous; transport has its own caps
  'post-response': 1_000,
  'post-session': 300,
  'cross-session': 500,
} as const;
