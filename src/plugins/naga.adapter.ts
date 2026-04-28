/* enchanter/src/plugins/naga.adapter.ts — v0.2 working implementation.
   Implements architecture-spec phase_4.failure_mode_2 (tool poisoning / schema
   mutation) + phase_4.failure_mode_10 (MCPoison schema injection) as secondary
   defense-in-depth via multi-axis structural fingerprinting sourced from
   plugins/naga source (N1 shape hash, N2 TF-IDF token signature, N3 naming
   convention). Complements the primary namespace-registry digest check. */

import { createHash } from 'node:crypto';
import type { PluginAdapter } from './plugin-contract.js';
import type { EnchantedEvent, PluginAck } from '../bus/event-types.js';
import type { RequestContext } from '../orchestration/request-context.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type NamingConvention = 'camel' | 'snake' | 'pascal' | 'kebab' | 'mixed';

export interface TripleAxisFingerprint {
  /** N1 simplified shape: SHA-1 of {param_count, param_types_sorted, has_outputSchema} */
  n1: string;
  /** N2 TF-IDF token signature: top-20 terms by TF (lowercased, stop-words dropped) [author judgment: top-20] */
  n2: string[];
  /** N3 naming-convention fingerprint of parameter names */
  n3: NamingConvention;
}

// Stored entry per qualified tool name (server_id.tool_name).
interface FingerprintEntry {
  readonly qualifiedName: string;
  readonly fingerprint: TripleAxisFingerprint;
}

// ---------------------------------------------------------------------------
// N2 stop-word list (English function words — no external dep required)
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'should', 'could', 'may', 'might', 'can', 'this', 'that', 'it', 'its',
  'which', 'who', 'what', 'when', 'where', 'how', 'not', 'no', 'if', 'as',
  'than', 'then', 'so', 'up', 'out', 'about', 'into', 'through', 'during',
  'each', 'all', 'any', 'both', 'few', 'more', 'most', 'other', 'such',
]);

// ---------------------------------------------------------------------------
// N1 — simplified shape hash
// ---------------------------------------------------------------------------

/** Extracts a sorted list of JSON Schema primitive type strings from a schema. */
function extractParamTypes(inputSchema: Record<string, unknown>): string[] {
  const props = (inputSchema['properties'] ?? {}) as Record<string, { type?: unknown }>;
  return Object.values(props)
    .map((p) => (typeof p.type === 'string' ? p.type : 'unknown'))
    .sort();
}

function computeN1(toolSchema: McpToolSchema): string {
  const inputSchema = (toolSchema.inputSchema ?? {}) as Record<string, unknown>;
  const props = (inputSchema['properties'] ?? {}) as Record<string, unknown>;
  const paramCount = Object.keys(props).length;
  const paramTypesSorted = extractParamTypes(inputSchema);
  const hasOutputSchema = 'outputSchema' in toolSchema && toolSchema.outputSchema !== undefined;

  const repr = JSON.stringify({ paramCount, paramTypesSorted, hasOutputSchema });
  // [author judgment: simplified N1 uses SHA-1 of the stable JSON repr rather
  //  than full Zhang-Shasha AST tree-edit distance — sufficient for schema-drift
  //  detection at the tool description level]
  return createHash('sha1').update(repr).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// N2 — TF-IDF token signature (simplified: TF only, corpus is one document)
// ---------------------------------------------------------------------------

function computeN2(description: string): string[] {
  // Tokenize: split on whitespace + punctuation, lowercase, drop stop-words.
  const tokens = description
    .toLowerCase()
    .split(/[\s\W]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));

  // Compute term frequency map.
  const tf = new Map<string, number>();
  for (const t of tokens) {
    tf.set(t, (tf.get(t) ?? 0) + 1);
  }

  // [author judgment: top-20 terms by TF; Jaccard threshold=0.6 on set comparison]
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([term]) => term);
}

// ---------------------------------------------------------------------------
// N3 — naming-convention fingerprint of parameter names
// ---------------------------------------------------------------------------

const CAMEL_RE = /^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/;
const SNAKE_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PASCAL_RE = /^[A-Z][a-zA-Z0-9]+$/;
const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

function detectConvention(name: string): NamingConvention {
  if (CAMEL_RE.test(name)) return 'camel';
  if (SNAKE_RE.test(name)) return 'snake';
  if (PASCAL_RE.test(name)) return 'pascal';
  if (KEBAB_RE.test(name)) return 'kebab';
  return 'mixed';
}

function computeN3(inputSchema: Record<string, unknown>): NamingConvention {
  const props = (inputSchema['properties'] ?? {}) as Record<string, unknown>;
  const names = Object.keys(props);
  if (names.length === 0) return 'mixed';

  const counts: Record<NamingConvention, number> = {
    camel: 0, snake: 0, pascal: 0, kebab: 0, mixed: 0,
  };
  for (const n of names) {
    counts[detectConvention(n)]++;
  }

  // Majority convention wins; ties go to 'mixed'.
  let best: NamingConvention = 'mixed';
  let bestCount = 0;
  for (const [conv, count] of Object.entries(counts) as [NamingConvention, number][]) {
    if (count > bestCount) {
      bestCount = count;
      best = conv;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Fingerprint computation entry point
// ---------------------------------------------------------------------------

interface McpToolSchema {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly outputSchema?: unknown;
}

function computeFingerprint(tool: McpToolSchema): TripleAxisFingerprint {
  const inputSchema = (tool.inputSchema ?? {}) as Record<string, unknown>;
  return {
    n1: computeN1(tool),
    n2: computeN2(tool.description ?? ''),
    n3: computeN3(inputSchema),
  };
}

// ---------------------------------------------------------------------------
// Drift comparison
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity between two string sets.
 * [author judgment: Jaccard threshold=0.6 — below this the N2 token set has
 *  changed enough to signal a material description rewrite, not just minor
 *  wording tweaks]
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const t of setA) {
    if (setB.has(t)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

const JACCARD_THRESHOLD = 0.6; // [author judgment]

type DriftKind = 'n1' | 'n2' | 'n3';

interface DriftResult {
  readonly hasDrift: boolean;
  readonly axes: DriftKind[];
  /** true when drift is structurally significant → veto */
  readonly structural: boolean;
}

function detectDrift(stored: TripleAxisFingerprint, current: TripleAxisFingerprint): DriftResult {
  const axes: DriftKind[] = [];

  if (stored.n1 !== current.n1) axes.push('n1');
  const jaccard = jaccardSimilarity(stored.n2, current.n2);
  if (jaccard < JACCARD_THRESHOLD) axes.push('n2');
  if (stored.n3 !== current.n3) axes.push('n3');

  const structural = axes.includes('n1') || axes.includes('n3');
  return { hasDrift: axes.length > 0, axes, structural };
}

// ---------------------------------------------------------------------------
// Module-level fingerprint store (in-process; keyed by qualified tool name)
// ---------------------------------------------------------------------------

const _store = new Map<string, FingerprintEntry>();

/** Exposed for test isolation: clear all stored fingerprints. */
export function _clearFingerprintStore(): void {
  _store.clear();
}

// ---------------------------------------------------------------------------
// Phase handlers
// ---------------------------------------------------------------------------

function handleTrustGate(event: EnchantedEvent): PluginAck {
  if (event.topic !== 'mcp.tools.list.received') {
    return { status: 'ack' };
  }

  const payload = event.payload as {
    server_id?: string;
    tools?: McpToolSchema[];
  };

  const serverId = payload.server_id ?? 'unknown';
  const tools = Array.isArray(payload.tools) ? payload.tools : [];

  const driftEvents: EnchantedEvent[] = [];
  let shouldVeto = false;
  const vetoReasons: string[] = [];

  for (const tool of tools) {
    if (typeof tool.name !== 'string') continue;
    const qualifiedName = `${serverId}.${tool.name}`;
    const current = computeFingerprint(tool);

    const existing = _store.get(qualifiedName);
    if (!existing) {
      // First registration — store and continue.
      _store.set(qualifiedName, { qualifiedName, fingerprint: current });
      continue;
    }

    const drift = detectDrift(existing.fingerprint, current);
    if (!drift.hasDrift) continue;

    // Drift detected — emit derived event and decide veto/degraded.
    driftEvents.push({
      id: `${event.correlation_id}::naga-drift::${qualifiedName}`,
      correlation_id: event.correlation_id,
      session_id: event.session_id,
      phase: event.phase,
      topic: 'naga.schema.drift.detected',
      source: 'naga',
      budget_tier: event.budget_tier,
      ts: Date.now(),
      payload: {
        qualified_name: qualifiedName,
        axes: drift.axes,
        structural: drift.structural,
        n1_match: !drift.axes.includes('n1'),
        n3_match: !drift.axes.includes('n3'),
        jaccard: jaccardSimilarity(existing.fingerprint.n2, current.n2),
      },
    });

    if (drift.structural) {
      shouldVeto = true;
      vetoReasons.push(
        `naga-drift-veto:${qualifiedName} axes=[${drift.axes.join(',')}]`,
      );
    }
  }

  if (shouldVeto) {
    return {
      status: 'veto',
      reason: vetoReasons.join('; '),
      derived_events: driftEvents,
    };
  }

  if (driftEvents.length > 0) {
    // N2-only drift: degraded ack, not veto.
    return {
      status: 'ack',
      degraded: true,
      reason: `naga-drift-n2: ${driftEvents.length} tool(s) show token-set drift`,
      derived_events: driftEvents,
    };
  }

  return { status: 'ack' };
}

function handlePostResponse(event: EnchantedEvent): PluginAck {
  // Artifact shape-check placeholder — emits ack; detailed N4 fidelity scoring
  // is skill-invoked via /naga:validate, not continuous.
  void event;
  return { status: 'ack' };
}

function handlePostSession(_event: EnchantedEvent): PluginAck {
  // N5 Gauss Accumulation is PreCompact-hook-driven in the naga-learning
  // sub-plugin; the enchanter adapter emits ack here.
  return { status: 'ack' };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const nagaAdapter: PluginAdapter = {
  name: 'naga',
  phases: ['trust-gate', 'post-response', 'post-session'],
  // required=true for failure-mode 2/10 secondary mitigation — fail-closed on
  // N1/N3 structural drift. N2-only drift fails open with degraded=true.
  required: true,
  topics: {
    subscribes: ['mcp.tools.list.received', 'mcp.tool.result.received', 'compact.requested'],
    emits: ['naga.pattern.fingerprinted', 'naga.fidelity.measured', 'naga.schema.drift.detected'],
  },
  budget_tier: 'always',

  async onPhase(event: EnchantedEvent, _ctx: RequestContext): Promise<PluginAck> {
    if (event.phase === 'trust-gate') return handleTrustGate(event);
    if (event.phase === 'post-response') return handlePostResponse(event);
    if (event.phase === 'post-session') return handlePostSession(event);
    return { status: 'ack' };
  },
};
