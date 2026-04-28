/* enchanter/src/plugins/pech.adapter.ts — v0.2 working implementation.
   Cites: architecture-spec phase_5.budget_thresholds + plugins/pech source
   (README.md §Engine L2: Budget Boundary Detection, §The Full Lifecycle).

   v0.2 scope: in-memory ledger, per-vendor budget tracking, tier-boundary
   threshold events, vendor-exhaustion events. Deferred to v0.3: L1 EMA
   forecast, L3 Z-score anomaly, L4 cache-waste, file-backed ledger.

   [author judgment] In-memory ledger chosen for v0.2 — zero I/O latency on
   the post-response hot path and no filesystem permission surface needed at
   this tier. File-backed (append-only JSONL) is the v0.3 target once the
   rate-card-keeper sub-plugin lands and attribution tuples are stable. */

import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';
import type { BudgetTier } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LedgerEntry {
  readonly ts: number;
  readonly session_id: string;
  readonly correlation_id: string;
  readonly plugin: string;
  readonly model: string;
  readonly vendor: string;
  readonly budget_tier: BudgetTier;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly tool_call_cost?: number;
}

/** Tier thresholds expressed as remaining-budget fractions (0–1). */
export interface TierThresholds {
  readonly high: number; // default 0.7 — remaining ≥ 70% = HIGH
  readonly med: number;  // default 0.3 — remaining ≥ 30% = MED
  readonly low: number;  // default 0.1 — remaining ≥ 10% = LOW
  // below low → EXHAUSTED (remaining ≤ 0 triggers vendor.exhausted)
}

interface VendorBudget {
  limit_tokens: number;
  used: number;
}

export interface PechConfig {
  vendor_budgets?: Map<string, { limit_tokens: number; used: number }>;
  tier_thresholds?: Partial<TierThresholds>;
}

// ---------------------------------------------------------------------------
// Module-level mutable state
// (singleton per process; reset via clear())
// ---------------------------------------------------------------------------

const _ledger: LedgerEntry[] = [];
const _vendor_budgets: Map<string, VendorBudget> = new Map();

const _thresholds: TierThresholds = {
  high: 0.7,
  med: 0.3,
  low: 0.1,
};

/** Maps vendor → last emitted tier label so we can detect boundary crossings. */
const _last_tier: Map<string, string> = new Map();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function computeTierLabel(remaining_pct: number, t: TierThresholds): string {
  if (remaining_pct >= t.high) return 'HIGH';
  if (remaining_pct >= t.med)  return 'MED';
  if (remaining_pct >= t.low)  return 'LOW';
  return 'CRITICAL';
}

function makeDerivedEvent(
  event: EnchantedEvent,
  topic: string,
  payload: Record<string, unknown>,
): EnchantedEvent {
  return {
    id: `${event.correlation_id}::pech-${topic}`,
    correlation_id: event.correlation_id,
    session_id: event.session_id,
    phase: event.phase,
    topic,
    source: 'pech',
    budget_tier: event.budget_tier,
    ts: Date.now(),
    payload,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function setBudget(vendor: string, limit_tokens: number): void {
  const existing = _vendor_budgets.get(vendor);
  _vendor_budgets.set(vendor, { limit_tokens, used: existing?.used ?? 0 });
}

export function getLedger(): ReadonlyArray<LedgerEntry> {
  return _ledger;
}

export function getRemainingByVendor(vendor: string): number {
  const b = _vendor_budgets.get(vendor);
  if (!b) return Infinity;
  return Math.max(0, b.limit_tokens - b.used);
}

export function clear(): void {
  _ledger.length = 0;
  _vendor_budgets.clear();
  _last_tier.clear();
}

export function configurePech(config: PechConfig): void {
  if (config.vendor_budgets) {
    for (const [vendor, budget] of config.vendor_budgets) {
      _vendor_budgets.set(vendor, { ...budget });
    }
  }
  if (config.tier_thresholds) {
    const t = _thresholds as unknown as { high: number; med: number; low: number };
    if (config.tier_thresholds.high !== undefined) t.high = config.tier_thresholds.high;
    if (config.tier_thresholds.med  !== undefined) t.med  = config.tier_thresholds.med;
    if (config.tier_thresholds.low  !== undefined) t.low  = config.tier_thresholds.low;
  }
}

// ---------------------------------------------------------------------------
// Core post-response handler
// ---------------------------------------------------------------------------

function handlePostResponse(event: EnchantedEvent): PluginAck {
  const p = event.payload as Record<string, unknown>;

  // Extract token counts from event.payload.tokens (default 0/0 if absent).
  const tokens = (p['tokens'] as Record<string, unknown> | undefined) ?? {};
  const input_tokens  = typeof tokens['input']  === 'number' ? tokens['input']  : 0;
  const output_tokens = typeof tokens['output'] === 'number' ? tokens['output'] : 0;
  const tool_call_cost = typeof p['tool_call_cost'] === 'number' ? p['tool_call_cost'] : undefined;

  const plugin = typeof p['plugin'] === 'string' ? p['plugin'] : event.source;
  const model  = typeof p['model']  === 'string' ? p['model']  : 'unknown';
  const vendor = typeof p['vendor'] === 'string' ? p['vendor'] : 'unknown';

  // Append to ledger — push-only, never mutate existing entries.
  const entry: LedgerEntry = {
    ts: Date.now(),
    session_id: event.session_id,
    correlation_id: event.correlation_id,
    plugin,
    model,
    vendor,
    budget_tier: event.budget_tier,
    input_tokens,
    output_tokens,
    ...(tool_call_cost !== undefined ? { tool_call_cost } : {}),
  };
  _ledger.push(entry);

  const derived_events: EnchantedEvent[] = [
    makeDerivedEvent(event, 'pech.ledger.appended', {
      plugin,
      model,
      vendor,
      input_tokens,
      output_tokens,
    }),
  ];

  // Budget tracking + threshold detection.
  const budget = _vendor_budgets.get(vendor);
  if (budget !== undefined) {
    budget.used += input_tokens + output_tokens;

    const remaining = Math.max(0, budget.limit_tokens - budget.used);
    const remaining_pct = budget.limit_tokens > 0 ? remaining / budget.limit_tokens : 0;

    if (remaining_pct <= 0) {
      // Vendor fully exhausted.
      derived_events.push(
        makeDerivedEvent(event, 'pech.vendor.exhausted', { vendor, remaining_pct: 0 }),
      );
      _last_tier.set(vendor, 'EXHAUSTED');
    } else {
      const new_tier = computeTierLabel(remaining_pct, _thresholds);
      const old_tier = _last_tier.get(vendor) ?? computeTierLabel(1, _thresholds); // starts at HIGH

      if (new_tier !== old_tier) {
        derived_events.push(
          makeDerivedEvent(event, 'pech.threshold.crossed', {
            vendor,
            old_tier,
            new_tier,
            remaining_pct,
          }),
        );
      }
      _last_tier.set(vendor, new_tier);
    }
  }

  return { status: 'ack', derived_events };
}

// ---------------------------------------------------------------------------
// Plugin adapter
// ---------------------------------------------------------------------------

// TODO(v0.3): EMA forecast (L1 engine); Z-score anomaly detection (L3).

export const pechAdapter: PluginAdapter = {
  name: 'pech',
  phases: ['post-response'],
  required: true, // always-tier per architecture-spec phase_5; fail-closed
  topics: {
    subscribes: ['mcp.tool.result.received', 'sampling.completed'],
    emits: ['pech.ledger.appended', 'pech.threshold.crossed', 'pech.vendor.exhausted'],
  },
  budget_tier: 'always',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase === 'post-response') {
      return handlePostResponse(event);
    }
    return { status: 'ack' };
  },
};
