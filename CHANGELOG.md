# Changelog

All notable changes to Enchanter are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] — 2026-04-29

### Added
- **CLI inspector** — long-running boxed minimalist real-time observability monitor (`npm run inspect`). Smart frame-diff redraw (no flicker), 4 golden-signal cards on top (turns left, spent, security alerts, drift), per-plugin sparklines (6-char Unicode block trends), event log with topic-family colors, phase progress bar with amber pulse on the active phase, sticky hint footer, mode banner pills (LIVE / PAUSED / FILTER / SORT). Long-running until `q` or Ctrl-C. Keyboard-driven: `r` re-run demo, `s` stress, `x` red-team, `p` pause, `/` filter, `S` sort, `↑↓` scroll history, `?` help.
- **Mascot** — 2D Unicode block-art chibi grimoire (gold pages + violet body + black eyes + red ribbon) rendered in the inspector header. `MascotPaint` interface with per-cell color masks; `renderMascot()` helper applies multi-color ANSI escapes.
- **VS Code extension** (`vscode-extension/`) — native TreeViews (Plugins / Events / Phases) + StatusBarItem + WelcomeView. No webview. `ws` dep dropped — uses Node's native `WebSocket` global. VSIX 120 KB, 29 files. Connects to the WebSocket broadcaster.
- **Stress test** (`scripts/stress-plugins.ts`, `npm run stress`) — 14 attack scenarios, one per plugin hotspot. 14/14 pass.
- **Red team** (`scripts/red-team.ts`, `npm run red-team`) — 26 advanced exploits in 5 tiers (hydra evasion, secret-pattern coverage, SSRF, resource exhaustion, schema mutation). Honest BLOCKED / BYPASSED / DEGRADED / N/A reporting. 11 BLOCKED + 13 BYPASSED (v0.3 follow-ups documented per scenario).
- **Desktop notifier** (`src/observability/notifier.ts`) — `node-notifier`-backed OS toasts on hydra/sylph/lich/naga/pech alerts. Throttled per-topic. Auto-wired into the inspector.
- **Documentation surfaces** — interactive HTML demo at `docs/index.html` (clickable counters, demo + stress buttons, mascot, full inspector layout) for GitHub Pages, plus animated SVG hero at `docs/hero.svg` (SMIL-driven counters, sparklines, phase pulse, LIVE badge — auto-loops in the README).

### Changed
- **Hydra command-injection scanner** — now reconstructs the command line from `tool` + `args` array fields, defeating the `{tool:"git", args:["push","--force"]}` evasion. `h-curl-pipe-shell` bumped to `critical` severity (was `high` warn-only) — RCE-class.
- **Sylph W5 destructive-op gate** — same reconstruction logic. Vetoes `git push --force`, `git reset --hard`, `git branch -D` even when split across `tool` + `args`.
- **Bus topic matcher** (`src/bus/pubsub.ts`) — `*` wildcard now matches any topic. Previously plain `*` was treated as a literal topic name. AckTracker gained `has(correlation_id, phase, plugin)` for orchestrator dedup.
- **Test count**: 136 → **144 passing** (added notifier + integration test scenarios). 7 todo, 0 fail.

### Removed
- VS Code extension's `ws` npm dependency (uses native `WebSocket`).
- VS Code extension webview UI (replaced by native TreeViews per Microsoft UX guidance — webviews cost performance + accessibility versus core API).

## [0.2.1] — 2026-04-28

### Removed
- **Browser dashboard (Vite + Preact UI)** — dropped because terminal + VS Code surfaces are in-context where developers work; the dashboard required active browser-tab visiting and got ignored. The WebSocket broadcaster (`src/observability/dashboard-server.ts`) stays — VS Code's webview consumes it. Notifier stays. Bus, orchestrator, plugins, transports unchanged.
- `scripts/run-dashboard.ts` — launcher that spawned Vite + the browser UI.
- `npm run dashboard` and `npm run dashboard:dev` scripts removed from `package.json`.

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
