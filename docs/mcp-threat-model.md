# Beholder MCP Threat Model (2025–2026)

MCP is now a mainstream attack surface: 40+ CVEs were disclosed against MCP implementations between January and April 2026, spanning the Python, TypeScript, Java, and Rust SDKs, and both NSA/CISA (June 2026 CSI, "Model Context Protocol (MCP): Security Design") and the Cloud Security Alliance / Ox Security ("MCP by Design: RCE Across the AI Agent Ecosystem", April 2026) have published dedicated guidance. Most published attacks — tool poisoning, rug pulls, tool shadowing, confused-deputy OAuth, injection-driven RCE — cross the boundary between servers and the host at the client. The client is therefore the natural enforcement point: it sees every tool registration, every request, and every response before the model or the user acts on them. Beholder is a TypeScript MCP-client SDK plus a Rust observability inspector with a security veto; this document maps its defenses onto that threat landscape.

## Enforcement model

Beholder runs a 7-phase request lifecycle: **anchor → trust-gate → pre-dispatch → dispatch → post-response → post-session → cross-session**. Defenses attach to specific phases. Veto semantics: critical pattern hits BLOCK (SDK raises `SecurityVetoError` and fails closed; the Claude Code hook returns `permissionDecision:"deny"`); high-severity hits are advisory (warn). The veto core fails OPEN on internal error — a fault in the veto path never denies a legitimate request, and this is a deliberate availability/security trade-off a reviewer should note (see residual risk below).

## Threat class → defense mapping

| Threat class (2026 landscape) | Beholder defense | Lifecycle phase | Coverage |
|---|---|---|---|
| Tool poisoning — malicious instructions hidden in tool descriptions | `h-mcp-tool-poisoning` pattern: matches `<IMPORTANT>`, ignore-previous-instructions, do-not-tell-the-user markers | trust-gate, post-response | Advisory |
| Line jumping — injection in a tool description executed before user approval | Same pattern table applied at trust-gate, i.e. before dispatch; plus bidirectional control channel requiring human approve/veto | trust-gate | Advisory + human gate |
| Rug pulls / silent tool redefinition | Namespace registry with SHA-256 schema-digest pin — a tool whose schema changed after registration is rejected ("MCPoison defense") | trust-gate | Rejects |
| Cross-server tool shadowing | Tool name collision rejection — two servers registering the same tool name is refused | trust-gate | Rejects |
| Server identity swap (binary, args, env, endpoint) | Full trust-pin: SHA-256 over cmd + args + url + schemaDigests + binaryDigest + envAllowlist | trust-gate | Rejects |
| Confused-deputy OAuth flaws / token misredirection (cf. CVE-2026-13341 class) | OAuth 2.1 + S256 PKCE + RFC 8707 audience binding + SSRF guard; OAuth replay defense (nonce + freshness store) | anchor / trust-gate | Blocks |
| Consent-fatigue attacks | Bidirectional control channel: explicit human approve/veto, fail-closed on timeout — absence of a decision is a veto, not an approval | trust-gate | Blocks (on timeout) |
| Command injection via tool arguments (cf. CVE-2026-0755, CVE-2026-0756, CVE-2025-68143/44/45) | `h-mcp-cmd-injection`: `$(...)`, backticks, `;`/`&&`/`\|\|` chaining into rm/curl/bash/etc. | trust-gate, post-response | Advisory |
| Mobile-intent RCE (cf. CVE-2026-35394) | `h-mcp-intent-rce`: `am start`, `intent://`, USSD `tel:` with `*`/`#` | trust-gate, post-response | Advisory |
| Destructive / exfil shell payloads | Shell-class critical patterns (see table below), `h-reverse-shell`, `h-secret-file-exfil` | trust-gate, post-response | Blocks |
| Lethal trifecta — outbound egress of private data | `h-secret-file-exfil`, `h-ssh-key-exfil` (blocks known exfil shapes); secret masking of credentials in tool responses | post-response | Partial — pattern + mask, not egress policy |
| Credential leakage through tool responses | hydra secret masking: AWS keys, bearer tokens, PEM private keys, Anthropic/OpenAI keys | post-response | Masks |
| Transport MITM on streaming HTTP | TLS cert pinning (TOFU + PINNED) | dispatch | Blocks |
| Cross-client data leakage inside the SDK itself (CVE-2026-25536 class) | None — code-level SDK bug, not a runtime pattern | — | Out of scope |
| Exposed inspector/management endpoints (CVE-2026-23744 class) | None for third-party tools' own listeners | — | Out of scope |

## hydra veto pattern table (v0.6, 10 patterns)

The pattern table is CVE-anchored and shared between the trust-gate and post-response phases.

| ID | Severity | Anchor |
|---|---|---|
| h-rm-rf-root | critical (blocks) | shell-class destructive delete |
| h-fork-bomb | critical (blocks) | shell-class resource exhaustion |
| h-curl-pipe-shell | critical (blocks) | shell-class remote-code fetch-and-run |
| h-ssh-key-exfil | critical (blocks) | shell-class key exfiltration |
| h-sudo-nopasswd | critical (blocks) | shell-class privilege persistence |
| h-reverse-shell | critical (blocks) | reverse-shell connect-back |
| h-secret-file-exfil | critical (blocks) | secret-file read + egress |
| h-mcp-tool-poisoning | advisory (warns) | `<IMPORTANT>` / ignore-previous-instructions / do-not-tell-the-user markers |
| h-mcp-cmd-injection | advisory (warns) | `$(...)`, backticks, `;`/`&&`/`\|\|` chaining into rm/curl/bash/etc. |
| h-mcp-intent-rce | advisory (warns) | `am start` / `intent://` / USSD `tel:` with `*`/`#` (CVE-2026-35394 class) |

## What Beholder does NOT catch

Honest limits. A reviewer should treat these as residual risk, not edge cases.

- **Code-level SDK vulnerabilities.** CVE-2026-25536 (cross-client data leakage via shared transport instances in the TypeScript SDK) is a bug in library internals. No runtime pattern or trust-pin observes it. Beholder's own SDK code is subject to the same class of risk.
- **Semantic tool poisoning.** `h-mcp-tool-poisoning` matches known heuristic markers. A poisoned description written in natural persuasive prose, with none of those markers, passes the pattern table. The human approve/veto channel is the only remaining control, and it depends on the human actually reading the description.
- **Behavioral rug pulls with a stable schema.** The schema-digest pin catches a tool whose *schema* changes. A server that keeps the schema byte-identical but changes what the implementation *does* is invisible to the pin. binaryDigest in the trust-pin covers locally-launched binaries; a remote server's backend can change freely.
- **Anything Beholder does not proxy.** Servers reached by other clients, endpoints a server binds itself (the CVE-2026-23744 MCPJam Inspector class: unauthenticated endpoint on 0.0.0.0), and side channels a tool opens after dispatch are outside the lifecycle.
- **The lethal trifecta in full generality.** Beholder blocks known exfil shapes and masks known credential formats. It does not enforce a general egress policy; novel encodings or unrecognized secret formats can transit post-response unmasked.
- **Advisory-tier evasion.** The three MCP-specific patterns are advisory in v0.6: they warn, they do not block. An attacker who accepts the warning being logged still gets execution unless a human vetoes.
- **Fail-open on internal error.** A crash in the veto engine disables it for that request. An attacker who can trigger an inspector fault gets an unvetoed pass.
- **Confused deputies inside a trusted server.** CVE-2026-13341 (Kong Konnect MCP: indirect prompt injection driving unintended API requests) executes within a server's legitimate authority. Beholder's OAuth audience binding limits token misuse across services, but a request that is well-formed, in-audience, and pattern-clean is not distinguishable from an intended one.

## Sources

- NSA/CISA Cybersecurity Information Sheet, "Model Context Protocol (MCP): Security Design", June 2026.
- Cloud Security Alliance / Ox Security research note, "MCP by Design: RCE Across the AI Agent Ecosystem", April 2026.
- Disclosure volume: 40+ CVEs against MCP implementations, January–April 2026 (Python/TypeScript/Java/Rust SDKs).
- CVE-2026-25536 — TypeScript SDK cross-client data leakage via shared transport instances.
- CVE-2026-35394 — Mobilenexthq Mobile MCP RCE via `mobile_open_url` unvalidated Android intent (CVSS 8.8).
- CVE-2026-13341 — Kong Konnect MCP server indirect prompt injection driving unintended API requests (confused deputy at production scale).
- CVE-2026-23744 — MCPJam Inspector RCE via unauthenticated endpoint bound to 0.0.0.0.
- CVE-2026-0755 — gemini-mcp-tool command injection via unsanitized `execAsync`.
- CVE-2026-0756 — GitHub Kanban MCP Server arbitrary command execution.
- CVE-2025-68143 / CVE-2025-68144 / CVE-2025-68145 — git-mcp RCE chain (path-validation bypass + argument injection).
