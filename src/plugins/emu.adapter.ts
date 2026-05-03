/* enchanter/src/plugins/emu.adapter.ts — implements architecture-spec
   phase_1.emu (token economy monitoring + runway forecast with named drift
   patterns). Source: plugins/emu/README.md §§ A1 Markov Drift Detection,
   A2 Linear Runway Forecasting. v0.2 replaces the v0.1 stub. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TokenObservation {
  readonly ts: number;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly tool_call_id: string;
}

export interface RunwayForecast {
  readonly point_estimate: number;
  readonly ci_lower: number;
  readonly ci_upper: number;
  readonly mean_tokens_per_call: number;
  readonly sigma: number;
  readonly observation_count: number;
}

// ── Module-level state ────────────────────────────────────────────────────────

// [author judgment] Window cap at 100: enough history to detect patterns across
// a long session without unbounded growth. Lower bound 10 for CI validity.
const WINDOW_CAP = 100;

// [author judgment] Use last 10 observations for mean/σ — recent velocity
// matters more than session start; matches A2 description in README.
const FORECAST_WINDOW = 10;

// [author judgment] remaining_budget default — matches Emu's README example of
// C_max = 200,000. Callers can override via configureEmu().
let remainingBudget = 200_000;

const observations: TokenObservation[] = [];

// ── Public API ────────────────────────────────────────────────────────────────

export function configureEmu(opts: { remaining_budget?: number }): void {
  if (opts.remaining_budget !== undefined) remainingBudget = opts.remaining_budget;
}

/** Append a token usage observation. Called directly or via onPhase post-response. */
export function recordUsage(
  input_tokens: number,
  output_tokens: number,
  tool_call_id: string,
): void {
  observations.push({ ts: Date.now(), input_tokens, output_tokens, tool_call_id });
  // Evict oldest when over cap. [author judgment] single splice is cheap enough
  // at this window size.
  if (observations.length > WINDOW_CAP) {
    observations.splice(0, observations.length - WINDOW_CAP);
  }
}

/** Returns all observations (read-only). Exposed for testing. */
export function getObservations(): ReadonlyArray<TokenObservation> {
  return observations;
}

/** Clears the observation window. Exposed for testing. */
export function resetObservations(): void {
  observations.length = 0;
}

// ── Runway forecast ───────────────────────────────────────────────────────────

/**
 * Computes A2 Linear Runway Forecasting over the last FORECAST_WINDOW
 * observations. Returns undefined when fewer than 2 observations exist (cold
 * start — cannot form a meaningful mean or CI).
 *
 * Formula (README §A2):
 *   R_hat = remaining_budget / t̄_w
 *   95% CI: R_hat ± 1.96 · (σ_t / t̄_w)
 */
function computeRunway(): RunwayForecast | undefined {
  const slice = observations.slice(-FORECAST_WINDOW);
  if (slice.length < 2) return undefined; // cold start — insufficient data

  const totals = slice.map((o) => o.input_tokens + o.output_tokens);

  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  if (mean === 0) return undefined; // avoid division by zero

  const variance =
    totals.reduce((acc, t) => acc + (t - mean) ** 2, 0) / totals.length;
  const sigma = Math.sqrt(variance);

  const point_estimate = remainingBudget / mean;
  // 95% CI width: ±1.96 · (σ / t̄) · R_hat  (error propagation on ratio)
  const half_width = 1.96 * (sigma / mean) * point_estimate;

  return {
    point_estimate,
    ci_lower: Math.max(0, point_estimate - half_width),
    ci_upper: point_estimate + half_width,
    mean_tokens_per_call: mean,
    sigma,
    observation_count: slice.length,
  };
}

// ── Drift detection (A1 Markov Drift Detection) ───────────────────────────────

/**
 * Read-loop: 3+ consecutive observations share the same tool_call_id.
 * [author judgment] Threshold of 3 matches README §A1 θ=3.
 */
function detectReadLoop(): boolean {
  if (observations.length < 3) return false;
  const tail = observations.slice(-3);
  const id = tail[0]?.tool_call_id;
  return id !== undefined && tail.every((o) => o.tool_call_id === id);
}

/**
 * Edit-revert: alternating ABAB pattern in the last 4 observations.
 * [author judgment] Minimum 4 observations (2 full ABAB cycles) is the tightest
 * window that unambiguously identifies the pattern.
 */
function detectEditRevert(): boolean {
  if (observations.length < 4) return false;
  const tail = observations.slice(-4);
  const a = tail[0]?.tool_call_id;
  const b = tail[1]?.tool_call_id;
  return (
    a !== undefined &&
    b !== undefined &&
    a !== b &&
    tail[2]?.tool_call_id === a &&
    tail[3]?.tool_call_id === b
  );
}

// ── Derived-event builders ────────────────────────────────────────────────────

function makeDriftEvent(
  base: EnchantedEvent,
  pattern_name: string,
): EnchantedEvent {
  return {
    id: `${base.correlation_id}::emu-drift-${pattern_name}`,
    correlation_id: base.correlation_id,
    session_id: base.session_id,
    phase: base.phase,
    topic: 'emu.drift.pattern',
    source: 'emu',
    budget_tier: base.budget_tier,
    ts: Date.now(),
    payload: { pattern_name },
  };
}

function makeRunwayEvent(
  base: EnchantedEvent,
  forecast: RunwayForecast,
): EnchantedEvent {
  return {
    id: `${base.correlation_id}::emu-runway`,
    correlation_id: base.correlation_id,
    session_id: base.session_id,
    phase: base.phase,
    topic: 'emu.runway.forecast',
    source: 'emu',
    budget_tier: base.budget_tier,
    ts: Date.now(),
    payload: { ...forecast },
  };
}

// ── onPhase handlers ──────────────────────────────────────────────────────────

function handlePostResponse(event: EnchantedEvent): PluginAck {
  // Wire convention published by mcp-client and consumed by pech is
  // `tokens: { input, output }`. Older test fixtures and the v0.2 emu stress
  // scenario use `{ input_tokens, output_tokens }`. Read both — canonical first,
  // legacy second — so emu observations are non-zero against real tool traffic.
  const tokens = event.payload['tokens'] as
    | { input?: number; output?: number; input_tokens?: number; output_tokens?: number }
    | undefined;
  const input_tokens = tokens?.input ?? tokens?.input_tokens ?? 0;
  const output_tokens = tokens?.output ?? tokens?.output_tokens ?? 0;
  const tool_call_id =
    (event.payload['tool_call_id'] as string | undefined) ?? event.correlation_id;

  recordUsage(input_tokens, output_tokens, tool_call_id);

  const derived: EnchantedEvent[] = [];

  if (detectReadLoop()) {
    derived.push(makeDriftEvent(event, 'read-loop'));
  } else if (detectEditRevert()) {
    // Check edit-revert only when read-loop didn't fire — single pattern per
    // event keeps signal clean. [author judgment]
    derived.push(makeDriftEvent(event, 'edit-revert'));
  }

  return derived.length > 0
    ? { status: 'ack', derived_events: derived }
    : { status: 'ack' };
}

function handlePreDispatch(event: EnchantedEvent): PluginAck {
  const forecast = computeRunway();
  if (!forecast) return { status: 'ack' }; // cold start — nothing to emit

  return {
    status: 'ack',
    derived_events: [makeRunwayEvent(event, forecast)],
  };
}

// ── Adapter export ────────────────────────────────────────────────────────────

export const emuAdapter: PluginAdapter = {
  name: 'emu',
  phases: ['pre-dispatch', 'post-response'],
  required: false, // advisory — fail-open
  topics: {
    subscribes: ['mcp.tool.call.requested', 'mcp.tool.result.received'],
    emits: ['emu.runway.forecast', 'emu.compression.applied', 'emu.drift.pattern'],
  },
  budget_tier: 'med-or-higher',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    try {
      if (event.phase === 'post-response') return handlePostResponse(event);
      if (event.phase === 'pre-dispatch') return handlePreDispatch(event);
      return { status: 'ack' };
    } catch {
      // Fail-open per hooks.md and plugin-contract required:false contract.
      return { status: 'ack', degraded: true, reason: 'emu-internal-error' };
    }
  },
};
