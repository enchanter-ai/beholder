/* Type declarations for the plain-JS shared veto core (veto-core.mjs).
 * Lets the TypeScript SDK import the same module the stdlib-only Claude Code
 * hook consumes, so the CVE pattern table and block/warn decision live in
 * exactly one place. */

export interface VetoPattern {
  readonly id: string;
  readonly name: string;
  /** Anchor CVE or CVE-class identifier. */
  readonly cve_anchor: string;
  /** Match against a corpus view of the tool call. */
  readonly match: RegExp;
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  /** Why this pattern blocks. Surfaced in the veto reason. */
  readonly rationale: string;
}

export interface VetoInput {
  readonly tool?: string;
  readonly args?: unknown;
  readonly raw?: unknown;
}

export interface VetoDecision {
  /** True when a critical pattern matched — the call must be vetoed/denied. */
  readonly block: boolean;
  /** The critical pattern that triggered the block, or null. */
  readonly blocking: VetoPattern | null;
  /** All matched patterns (critical + advisory), de-duplicated. */
  readonly hits: VetoPattern[];
}

export declare const VETO_PATTERNS: ReadonlyArray<VetoPattern>;
export declare function buildCorpora(input: VetoInput): string[];
export declare function matchCorpora(corpora: string[]): VetoPattern[];
export declare function decideVeto(input: VetoInput): VetoDecision;
