/* enchanter/src/plugins/crow.adapter.ts — implements architecture-spec phase_1.crow + plugins/crow source. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Beta-Binomial posterior state
// ---------------------------------------------------------------------------

export interface BetaPosterior {
  /** α = success_count + 1  (prior α = 1 → uniform) */
  alpha: number;
  /** β = failure_count + 1  (prior β = 1 → uniform) */
  beta: number;
}

/**
 * Mutable in-process store: (server_id, tool_name) → Beta posterior.
 * Exported for test access; do not mutate from outside the adapter.
 */
export const posteriorStore = new Map<string, BetaPosterior>();

function posteriorKey(server_id: string, tool_name: string): string {
  return `${server_id}::${tool_name}`;
}

function getOrCreate(server_id: string, tool_name: string): BetaPosterior {
  const key = posteriorKey(server_id, tool_name);
  let p = posteriorStore.get(key);
  if (p === undefined) {
    // Uniform prior: Beta(1, 1) — mean = 0.5
    p = { alpha: 1, beta: 1 };
    posteriorStore.set(key, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Public API: update_posterior
// ---------------------------------------------------------------------------

/**
 * Feed an observation (success or failure) into the Beta-Binomial posterior
 * for the given (server_id, tool_name) pair.  Creates the posterior at the
 * uniform prior Beta(1,1) if it does not yet exist.
 *
 * update rule:
 *   α_new = α + 1   on success
 *   β_new = β + 1   on failure
 */
export function update_posterior(
  server_id: string,
  tool_name: string,
  success: boolean,
): BetaPosterior {
  const p = getOrCreate(server_id, tool_name);
  if (success) {
    p.alpha += 1;
  } else {
    p.beta += 1;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Derived statistics
// ---------------------------------------------------------------------------

/** Posterior mean of Beta(α,β) = α / (α+β). */
export function posteriorMean(p: BetaPosterior): number {
  return p.alpha / (p.alpha + p.beta);
}

/** Total observation count = (α − 1) + (β − 1) = α + β − 2.
 *  The prior contributes 0 observations; each update_posterior call adds one. */
export function observationCount(p: BetaPosterior): number {
  return p.alpha + p.beta - 2;
}

// ---------------------------------------------------------------------------
// Beta entropy (closed-form approximation)
//
// Exact formula: H(Beta(α,β)) = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β)
// where B is the beta function and ψ is the digamma function.
//
// JavaScript has no built-in digamma/log-gamma.  We use Stirling's-series
// log-gamma approximation (Lanczos g=7) and a recurrence-based digamma
// approximation.  This is accurate to ~1e-12 for α,β ≥ 1.
//
// [author judgment] Approximation: Lanczos log-gamma (g=7 coefficients) +
// digamma via asymptotic series after shifting by recurrence.  Simpler than
// importing a special-functions library; accurate enough for ordering/comparison
// which is the only consumer of this value inside the adapter.
// ---------------------------------------------------------------------------

/**
 * Lanczos log-gamma approximation (g=7, 9-term coefficients).
 * Valid for x > 0.
 */
function logGamma(x: number): number {
  const g = 7;
  const c = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) {
    // reflection formula: Γ(x)Γ(1-x) = π/sin(πx)
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  const z = x - 1;
  let a = c[0]!;
  for (let i = 1; i < g + 2; i++) {
    a += c[i]! / (z + i);
  }
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * Log of the Beta function: ln B(α,β) = ln Γ(α) + ln Γ(β) − ln Γ(α+β).
 */
function logBeta(alpha: number, beta: number): number {
  return logGamma(alpha) + logGamma(beta) - logGamma(alpha + beta);
}

/**
 * Digamma function ψ(x) via asymptotic series after reducing with the
 * recurrence ψ(x) = ψ(x+1) − 1/x until x ≥ 6, then:
 * ψ(x) ≈ ln(x) − 1/(2x) − 1/(12x²) + 1/(120x⁴) − 1/(252x⁶)
 *
 * [author judgment] We shift x up by at most 6 iterations — sufficient for
 * α,β starting at 1 and growing with each observation.  The asymptotic
 * series converges well for x ≥ 6.
 */
function digamma(x: number): number {
  let result = 0;
  // Shift up via recurrence until x ≥ 6
  while (x < 6) {
    result -= 1 / x;
    x += 1;
  }
  // Asymptotic series
  result += Math.log(x) - 1 / (2 * x);
  const x2 = x * x;
  result -= 1 / (12 * x2);
  result += 1 / (120 * x2 * x2);
  result -= 1 / (252 * x2 * x2 * x2);
  return result;
}

/**
 * Differential entropy of Beta(α,β) in nats.
 * H = ln B(α,β) − (α−1)ψ(α) − (β−1)ψ(β) + (α+β−2)ψ(α+β)
 */
export function betaEntropy(p: BetaPosterior): number {
  const { alpha: a, beta: b } = p;
  return (
    logBeta(a, b) -
    (a - 1) * digamma(a) -
    (b - 1) * digamma(b) +
    (a + b - 2) * digamma(a + b)
  );
}

// ---------------------------------------------------------------------------
// Review trigger
// ---------------------------------------------------------------------------

const REVIEW_MEAN_THRESHOLD = 0.5;
const REVIEW_MIN_OBSERVATIONS = 3;

function shouldTriggerReview(p: BetaPosterior): boolean {
  return (
    posteriorMean(p) < REVIEW_MEAN_THRESHOLD &&
    observationCount(p) >= REVIEW_MIN_OBSERVATIONS
  );
}

// ---------------------------------------------------------------------------
// PluginAdapter implementation
// ---------------------------------------------------------------------------

export const crowAdapter: PluginAdapter = {
  name: 'crow',
  phases: ['trust-gate'],
  required: false, // advisory — fail-open
  topics: {
    subscribes: ['mcp.tool.call.requested'],
    emits: ['crow.trust.scored', 'crow.review.ordered'],
  },
  budget_tier: 'med-or-higher',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase !== 'trust-gate') {
      return { status: 'ack' };
    }
    return handleTrustGate(event);
  },
};

function handleTrustGate(event: EnchantedEvent): PluginAck {
  // Extract server_id and tool_name from the event payload.
  // Payload shape (from architecture-spec): { tool, args, server_id? }
  const payload = event.payload;
  const rawTool = payload['tool'];
  const rawServer = payload['server_id'] ?? event.source;

  const tool_name = typeof rawTool === 'string' ? rawTool : String(rawTool ?? 'unknown');
  const server_id = typeof rawServer === 'string' ? rawServer : String(rawServer ?? 'unknown');

  const p = getOrCreate(server_id, tool_name);
  const mean = posteriorMean(p);
  const n = observationCount(p);
  const entropy = betaEntropy(p);

  // Always publish a trust-scored event so downstream consumers (the
  // inspector, lich's review-ordering, observability metrics) see the
  // running posterior on every trust-gate, not just at the review
  // threshold. Without this, crow declares `emits: ['crow.trust.scored',
  // 'crow.review.ordered']` but only the review path actually fires —
  // a contract gap that left crow appearing silent in normal sessions.
  const trustScoredEvent: EnchantedEvent = {
    id: `${event.correlation_id}::crow-scored`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'crow.trust.scored',
    source: 'crow',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: {
      server_id,
      tool_name,
      posterior_mean: mean,
      observation_count: n,
      entropy,
    },
  };

  if (!shouldTriggerReview(p)) {
    const degraded = mean < REVIEW_MEAN_THRESHOLD && n < REVIEW_MIN_OBSERVATIONS;
    return {
      status: 'ack',
      ...(degraded
        ? { degraded: true, reason: `crow: low mean ${mean.toFixed(3)} but cold-start (n=${n} < ${REVIEW_MIN_OBSERVATIONS})` }
        : {}),
      derived_events: [trustScoredEvent],
    };
  }

  // Review triggered: ALSO emit crow.review.ordered.
  const reviewEvent: EnchantedEvent = {
    id: `${event.correlation_id}::crow-review`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic: 'crow.review.ordered',
    source: 'crow',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload: {
      server_id,
      tool_name,
      trust_score: mean,
      observation_count: n,
      entropy,
      reason: `posterior mean ${mean.toFixed(3)} < ${REVIEW_MEAN_THRESHOLD} after ${n} observations`,
    },
  };

  return {
    status: 'ack',
    degraded: true,
    reason: `crow.review.ordered: ${server_id}.${tool_name} trust=${mean.toFixed(3)} n=${n}`,
    derived_events: [trustScoredEvent, reviewEvent],
  };
}
