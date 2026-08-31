/* beholder/src/plugins/hydra/veto-core.mjs — the single shared hydra
 * security-veto core, consumed by BOTH enforcement paths:
 *
 *   1. SDK path — src/plugins/hydra.adapter.ts (via cve-patterns.ts, which
 *      re-exports VETO_PATTERNS as CVE_PATTERNS_V0_1). The orchestrator turns
 *      a critical hit into a SecurityVetoError and fails the request closed.
 *   2. Auto-hook path — scripts/hooks/claude-code-emit.mjs (Claude Code
 *      PreToolUse hook). A critical hit now BLOCKS the tool call via the
 *      PreToolUse `permissionDecision: "deny"` contract.
 *
 * Before this module existed the two paths carried duplicate pattern tables
 * that drifted; the auto-hook path also only ever `exit 0`'d, so the shipped
 * default product observed hazards but never vetoed. This module is the one
 * place the CVE pattern table and the block/warn decision live.
 *
 * Written as plain ESM JavaScript (no build step) so the stdlib-only,
 * no-dependency Claude Code hook can import it directly, while the compiled
 * TypeScript SDK imports it through a sibling veto-core.d.mts. copy-assets.mjs
 * copies it into dist/ alongside the emitted .js.
 *
 * Decision rule (identical on both paths): a `critical` severity hit BLOCKS
 * (veto / deny); `high`/`medium`/`low` hits are advisory (warn but allow).
 */

/**
 * CVE-anchored pattern table (v0.6). Each entry names the CWE/CVE class it
 * anchors against. `critical` entries are high-confidence and block; the
 * `high` MCP entries are heuristic and advisory (warn, never block) — honest
 * about their false-positive surface. Kept in sync with the SDK's CvePattern
 * shape (id, name, cve_anchor, match, severity, rationale) so cve-patterns.ts
 * can re-export this array verbatim.
 */
export const VETO_PATTERNS = [
  {
    id: 'h-rm-rf-root',
    name: 'rm -rf / variants',
    cve_anchor: 'CWE-78 (OS Command Injection); historical: shellshock-class',
    match: /\brm\s+-[rRf]+\s+\/(?![a-zA-Z0-9_])/,
    severity: 'critical',
    rationale: 'destructive recursive delete from filesystem root',
  },
  {
    id: 'h-fork-bomb',
    name: 'fork bomb',
    cve_anchor: 'CWE-400 (Resource Exhaustion)',
    match: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:\s*&\s*[^}]*\}\s*;\s*:/,
    severity: 'high',
    rationale: 'classic fork-bomb pattern :(){:|:&};:',
  },
  {
    id: 'h-curl-pipe-shell',
    name: 'curl|sh remote-execution',
    cve_anchor: 'CWE-494 (Download of Code Without Integrity Check)',
    match: /\b(curl|wget)\s+[^|;&\n]+\|\s*(sh|bash|zsh|fish|powershell)/,
    severity: 'critical',
    rationale: 'piping remote content directly into a shell interpreter (RCE)',
  },
  {
    id: 'h-ssh-key-exfil',
    name: 'SSH private key access',
    cve_anchor: 'CWE-200 (Exposure of Sensitive Information)',
    match: /(?:cat|less|more|head|tail|read)\s+[^\n]*\.ssh\/id_(rsa|ed25519|ecdsa|dsa)\b/,
    severity: 'critical',
    rationale: 'reading SSH private key',
  },
  {
    id: 'h-sudo-nopasswd',
    name: 'sudo NOPASSWD escalation',
    cve_anchor: 'CWE-269 (Improper Privilege Management)',
    match: /\bsudo\s+(?:-n\s+)?(?:visudo|tee\s+\/etc\/sudoers|sh\s+-c\s+["']?echo[^"']*NOPASSWD)/,
    severity: 'critical',
    rationale: 'attempting to grant passwordless sudo',
  },
  // MCP-2026 threat classes. The five above anchor on shell-command hazards;
  // the MCP attack surface disclosed across 2025-2026 (40+ CVEs, NSA/CISA MCP
  // security guidance, CSA "MCP by Design: RCE") lands in the tool-call corpus
  // itself, so these anchor there.
  {
    id: 'h-reverse-shell',
    name: 'reverse shell',
    cve_anchor: 'CWE-78; MCP RCE post-exploitation (CSA/Ox "MCP by Design: RCE", 2026)',
    match: /\bnc\s+[^\n]*-[a-z]*e\b|\bbash\s+-i\b[^\n]*(?:>&|\/dev\/tcp)|\/dev\/tcp\/[0-9]/,
    severity: 'critical',
    rationale: 'reverse/bind shell — remote code execution callback',
  },
  {
    id: 'h-secret-file-exfil',
    name: 'credential-file read',
    cve_anchor: 'CWE-200; MCP lethal-trifecta exfil (external content + private data + egress)',
    match: /(?:cat|less|more|head|tail|type|read|xxd|base64)\s+[^\n]*(?:\.env\b|\.aws\/credentials|\.npmrc|\.git-credentials|\.docker\/config\.json|\.kube\/config)/,
    severity: 'critical',
    rationale: 'reading an environment/credential file (secret exfiltration)',
  },
  {
    id: 'h-mcp-tool-poisoning',
    name: 'tool-poisoning / line-jumping directive',
    cve_anchor: 'MCP tool poisoning + line jumping (Invariant Labs 2025; MCP threat class 2026)',
    match: /<IMPORTANT>|\bignore (?:all )?(?:previous|prior) instructions\b|\bdo not (?:tell|inform|mention|reveal|notify)[^\n]{0,20}\bthe user\b/i,
    severity: 'high',
    rationale: 'hidden instruction in a tool description/result — advisory, heuristic',
  },
  {
    id: 'h-mcp-cmd-injection',
    name: 'shell-metachar command injection',
    cve_anchor: 'CVE-2026-0755 / CVE-2026-0756 (MCP command injection via unsanitized exec)',
    match: /\$\([^)]+\)|`[^`]+`|(?:;|&&|\|\|)\s*(?:rm|curl|wget|nc|bash|sh|python|node)\b/,
    severity: 'high',
    rationale: 'command substitution or chaining into a spawned command — advisory',
  },
  {
    id: 'h-mcp-intent-rce',
    name: 'Android intent / USSD injection',
    cve_anchor: 'CVE-2026-35394 (Mobile MCP mobile_open_url intent RCE)',
    match: /\bam\s+start\b|intent:\/\/|(?:^|["'\s])tel:[^"'\s]*[*#]/,
    severity: 'high',
    rationale: 'unvalidated Android intent/USSD from a URL argument — advisory',
  },
];

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Reconstruct the corpus views a tool call is scanned against. Matching more
 * than one view defeats array-arg evasion:
 *   1. JSON-stringified raw payload/input — catches inline string args.
 *   2. Reconstructed `<tool> <args joined>` command line — so patterns
 *      anchored on tool-name boundaries (`rm -rf /`, `curl ... | bash`) match
 *      even when the MCP layer splits the tool name from its arguments.
 *
 * @param {{ tool?: string, args?: unknown, raw?: unknown }} input
 * @returns {string[]}
 */
export function buildCorpora(input) {
  const { tool = '', args, raw } = input ?? {};
  const corpora = [];
  if (raw !== undefined) corpora.push(safeJson(raw));
  const argString =
    Array.isArray(args) && args.every((a) => typeof a === 'string')
      ? args.join(' ')
      : typeof args === 'string'
        ? args
        : '';
  if (tool || argString) corpora.push(`${tool} ${argString}`.trim());
  return corpora;
}

/**
 * Match every corpus string against the pattern table, de-duplicating hits.
 * @param {string[]} corpora
 * @returns {Array<typeof VETO_PATTERNS[number]>}
 */
export function matchCorpora(corpora) {
  const hits = [];
  for (const corpus of corpora) {
    if (typeof corpus !== 'string' || corpus.length === 0) continue;
    for (const p of VETO_PATTERNS) {
      // Patterns are non-global, so .test() carries no lastIndex state.
      if (p.match.test(corpus) && !hits.includes(p)) hits.push(p);
    }
  }
  return hits;
}

/**
 * The shared veto decision. Blocks (veto/deny) on any `critical` hit; other
 * severities are advisory (warn but allow).
 *
 * @param {{ tool?: string, args?: unknown, raw?: unknown }} input
 * @returns {{ block: boolean, blocking: (typeof VETO_PATTERNS[number] | null), hits: Array<typeof VETO_PATTERNS[number]> }}
 */
export function decideVeto(input) {
  const hits = matchCorpora(buildCorpora(input));
  const blocking = hits.find((h) => h.severity === 'critical') ?? null;
  return { block: blocking !== null, blocking, hits };
}
