# Changelog

All notable changes to Enchanter are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned for v0.3
- OAuth replay defense (nonce + freshness store)
- TLS cert pinning + Authorization-header response-origin check
- Full trust-pin: SHA-256 over (cmd + args + binary digest + env + URL + schema)
- Lich M5 sandbox surface
- Djinn D2 HMM drift detection
- Pech file-backed ledger + L1 EMA / L3 Z-score / L4 cache-waste
- Gorgon Tarjan SCC + Python-AST extraction
- npm-publishable `@enchanter/plugin-*` packages

## [0.2.0] — 2026-04-27

### Added
- High-level `McpClient` class with JSON-RPC request/response correlation.
- 8 plugin adapter implementations (replacing v0.1 stubs):
  - **crow** — Beta-Binomial trust posterior + Lanczos log-Γ + asymptotic ψ for closed-form Beta entropy.
  - **djinn** — D1 LCS drift detection at anchor + post-session.
  - **emu** — A2 linear runway forecast + A1 read-loop / edit-revert pattern detection.
  - **gorgon** — language-agnostic PageRank with dangling-mass redistribution.
  - **lich** — M1 5-pattern static scan + M6 EMA false-positive learning. Required, fail-closed.
  - **naga** — N1 SHA-1 shape + N2 TF-IDF top-20 + N3 naming-convention fingerprint. Required.
  - **pech** — In-memory ledger + per-vendor budget tracking + tier-boundary thresholds. Required.
  - **sylph** — W5 6-pattern destructive-op gate + W2 Jaccard boundary clusters. Required.
- Streamable HTTP transport (single endpoint POST + GET, SSE, exp-backoff reconnect, resume disabled by default).
- End-to-end integration test suite (6 tests against a real Node subprocess MCP server).
- Live demo script (`scripts/demo-live.ts`) verified against `@modelcontextprotocol/server-filesystem`.

### Fixed
- **HIGH:** IPv6 SSRF guard — now blocks `::1`, `::ffff:` mapped, `fe80::/10`, `fc00::/7` (was only `::1`). 6 regression tests.
- **HIGH:** JSON-RPC parse — now validates method/id/error field shapes (was unchecked cast). 12 regression tests.
- **HIGH:** Hydra `rm -rf /` bypass — now reconstructs command line from string-array `args` (was missing array shape). 5 regression tests.
- **CRITICAL (false positive):** AckTracker deadline check — variable rename from `remaining` to `elapsedPastDeadline` for clarity.

### Architectural changes
- Orchestrator auto-subscribes each plugin to `lifecycle.<phase>` for every declared phase (per ADR-001). Without this, required plugins subscribed to domain topics never acked.
- AckTracker exposes `has()`; wired handler dedups invocations per (correlation_id, phase, plugin) to prevent double side-effects (e.g., pech ledger doubling).
- NamespaceRegistry resolves `byQualified` first, falls back to `byBare` (tools with dots in bare names like `shell.exec` are now correctly resolved).
- PluginAck.derived_events are now published to the bus by the wired handler (was stored on the ack but never reaching subscribers).

### Stats
- 41 TypeScript files / ~6700 LOC
- 18 test files / 136 tests / 7 todo / 0 fail
- 3 audit findings closed (HIGH); 5 medium / 5 low tracked for v0.3

## [0.1.0] — 2026-04-27 (initial reference)

### Added
- 7-phase orchestrator (anchor → trust-gate → pre-dispatch → dispatch → post-response → post-session → cross-session) with timeout-bounded fail-closed/fail-open.
- In-process pub/sub bus with bounded ring buffer + correlation_id stamping.
- stdio transport (newline-delimited UTF-8 JSON-RPC 2.0).
- OAuth 2.1 + S256 PKCE + RFC 8707 Resource Indicators.
- SSRF metadata guard (RFC 1918, link-local, cloud metadata, loopback).
- Namespace registry with SHA-256 schema-digest pin.
- Hydra reference plugin (5 CVE patterns + 5 secret-masking patterns).
- 33 tests across 5 test files.
