# Enchanter v0.2 — Implementation Summary

**Generated:** 2026-04-27
**Architecture spec:** `wixie/prompts/mcp-client-golden-architecture/output-opus-4-7.json`

## v0.2 Status

| Check | Result |
|---|---|
| `tsc --noEmit` | clean |
| `npm test` | **136 passing / 7 todo / 0 fail** (18 test files) |
| End-to-end integration | 6 tests against a real Node subprocess MCP server |
| Approved-deps-only | yes (zod, @opentelemetry/api, @opentelemetry/sdk-node, undici) |
| Audit verdict | HARDENING_NEEDED → **HARDENED** (4 findings fixed; 1 critical was a false positive) |
| Architectural issues caught by integration | **3 fixed**: lifecycle.\<phase\> auto-subscribe, ack dedup, qualified-first resolve |

## What changed v0.1 → v0.2

40 TypeScript files, 6267 LOC. From the v0.1 baseline (24 files, 1909 LOC) we added:

### Plugin adapters — 8 stubs replaced with working implementations
- **crow** (227 LOC) — Beta-Binomial trust posterior + Lanczos log-gamma + asymptotic digamma for closed-form Beta entropy. 8 tests.
- **djinn** (~210 LOC) — D1 LCS drift detection at anchor + post-session, immutable session anchor store. 5 tests. (D2 HMM deferred to v0.3.)
- **emu** (~220 LOC) — A2 Linear Runway Forecasting (mean ± 1.96σ CI), A1 read-loop / edit-revert pattern detection over 100-observation sliding window. 6 tests.
- **gorgon** (~270 LOC) — language-agnostic PageRank (Brin & Page d=0.85, max 50 iter, tolerance 1e-6) with dangling-node mass redistribution; cross-session snapshot + post-write hotspot-changed detection. 6 tests. (Tarjan SCC + Python-AST extraction → v0.3.)
- **lich** (~240 LOC) — primary owner of failure-mode 2 (tool poisoning). M1 static scan over 5 pattern categories (imperative-override, credential-request, suspicious TLD, base64-payload, hidden-Unicode) + M6 simplified EMA false-positive learning. **Required: true** — fail-closed. 7 tests.
- **naga** (~330 LOC) — multi-axis structural fingerprinting (N1 SHA-1 shape + N2 TF-IDF top-20 + N3 naming convention) with Jaccard similarity drift detection. **Required: true** for FM2/FM10 secondary mitigation. 6 tests.
- **pech** (~210 LOC) — in-memory ledger + per-vendor budget tracking + tier-boundary threshold detection (HIGH/MED/LOW/CRITICAL) + vendor-exhaustion kill switch. **Required: true** (always-tier per spec). 10 tests. (File-backed ledger + L1 EMA / L3 Z-score → v0.3.)
- **sylph** (~240 LOC) — W5 destructive-op gate (6 patterns: force-push, reset-hard, branch-D, rm-rf, force-with-lease, plain-push advisory) at trust-gate (**required: true**, fail-closed) + W2 boundary segmentation via Jaccard at post-session (advisory). 9 tests.

### Transport — Streamable HTTP fully implemented (was stub)
- **streamable-http.ts** (~340 LOC) — single-endpoint POST + GET, `Accept: application/json, text/event-stream`, undici-based; SSE multi-line `data:` parsing; 8MB body cap (failure-mode 5); exponential backoff (initial 500ms, factor 2, max 30s, ±20% jitter, 10 attempts max); resume disabled by default (failure-mode 8) with opt-in `allowResume + sessionNonce` binding. 7 tests.

### Tests — 7 todo placeholders → 3 real tests + 4 deferred
- `remaining-failure-modes.test.ts` rewritten: FM 3 (audience binding), FM 4 (secret masking), FM 10 (schema-digest mismatch) now have real coverage. FM 2/6/8/9 remain `it.todo` pointing at v0.3 surfaces.

## Audit findings — disposition

The code-review agent flagged 1 critical, 3 high, 5 medium, 5 low.

### Critical: AckTracker.waitForDeadline sign — **FALSE POSITIVE**
The `remaining` variable was misleadingly named (it was elapsed-past-deadline, not time-remaining). The `if (remaining > 0) return resolve()` correctly fires only after the deadline expires. Renamed to `elapsedPastDeadline` for clarity. Same logic, no behavior change.

### High 1: IPv6 SSRF guard — **FIXED**
v0.1 only blocked `[::1]`. v0.2 strips brackets, then checks:
- `::1` loopback
- `::ffff:` IPv4-mapped IPv6 (defensive blanket reject — WHATWG URL parser normalizes textual IPv4 to hex pairs, making per-octet checks brittle; no legitimate OAuth-metadata case for v4-mapped IPv6 literals)
- `fe80::/10` link-local (regex on lowercase prefix)
- `fc00::/7` unique-local

Public IPv6 (e.g., `[2606:4700:4700::1111]`) still passes. 6 new regression tests in `ssrf-oauth-metadata.test.ts`.

### High 2: JSON-RPC unchecked cast — **FIXED**
`parseJsonRpc` now validates field shapes after the `jsonrpc:"2.0"` check:
- `method` MUST be string if present
- `id` MUST be number / string / null if present
- `error.code` MUST be number, `error.message` MUST be string

12 new regression tests in `tests/protocol/jsonrpc-validation.test.ts`.

### High 3: Hydra rm-rf args-array bypass — **FIXED**
v0.1 stringified the payload; `rm -rf /` in `args: ["rm", "-rf", "/"]` slipped through because each arg is a JSON-quoted string. v0.2 also reconstructs the command line by joining string-array `args` and runs CVE patterns against both corpora. Deduplicates hits. 5 new regression tests in `tests/security/hydra-args-array.test.ts`.

### Medium / low — disposition
| # | Finding | Status |
|---|---|---|
| M1 | hydra `lastIndex` reset before `test()` | acknowledged; v0.3 |
| M2 | namespace registry deep-key sort for digest | acknowledged; v0.3 |
| M3 | advisory veto recorded as `degraded_findings` | acknowledged; v0.3 |
| M4 | lifecycle `contextFromEvent` hardcoded sampling_depth/deadline | tracked in v0.2 follow-ups |
| M5 | hydra HIGH severity warns instead of vetoes | acknowledged; v0.3 (configurable threshold) |
| L1 | `buildResourceParameter` doesn't invoke SSRF guard | v0.3 |
| L2 | Bus derived-event recursion has no depth guard | v0.3 |
| L3 | Phase event IDs deterministic not UUID | minor; v0.3 |
| L4 | PEM regex super-linear backtracking risk | v0.3 (bounded quantifier) |
| L5 | `pech.required = true` not enforced by CI guard | v0.3 |

## End-to-End Integration

A real Node subprocess (`tests/fixtures/mock-mcp-server.mjs`) speaking JSON-RPC over stdio is driven through the full v0.2 stack via the new `McpClient` class. 6 integration tests:

| Test | Proves |
|---|---|
| initialize → tools/list → tools/call | Real handshake, JSON-RPC ID correlation, namespace registration, dispatch through orchestrator |
| hydra vetoes `rm -rf /` via args-array | Trust-gate fail-closed; audit's args-array fix works live; SecurityVetoError propagates |
| schema-drift detection across 2× tools/list | Namespace SHA-256 digest pin catches mutated description (FM10 mitigation) |
| pech ledger appends per call | Vendor budget configured, one call → ledger grows by exactly 1 (verifies ack-dedup) |
| unknown qualified name rejected | `ToolNotFoundError` |
| bus tap shows all 7 phases | anchor / trust-gate / pre-dispatch / dispatch / post-response / post-session / cross-session |

### Architectural fixes the integration caught
1. **Plugins never acked** — adapters subscribed to domain topics (`mcp.tool.call.requested`) but the orchestrator publishes `lifecycle.<phase>`. Per ADR-001, plugins should subscribe to phase-named topics. Fixed: orchestrator auto-subscribes each plugin to `lifecycle.<phase>` for every declared phase. Plugins gate on `event.topic` in `onPhase`.
2. **Pech ledger doubled** — auto-subscribe meant the same phase fired the handler twice (one domain topic + one lifecycle topic). Fixed: `AckTracker.has()` + wired-handler dedup.
3. **`shell.exec` mis-resolved** — `query.includes('.')` heuristic treated tools-with-dots-in-bare-name as qualified. Fixed: `NamespaceRegistry.resolve` tries `byQualified` first, falls back to `byBare`.

## File Inventory

### Source (24 → 31 files, ~4000 LOC)
```
src/
├── orchestration/{lifecycle,request-context}.ts
├── bus/{event-types,pubsub}.ts
├── transport/{stdio,streamable-http}.ts
├── oauth/{pkce,resource-indicators,metadata-validator}.ts
├── registry/namespace.ts
├── protocol/jsonrpc.ts
├── plugins/
│   ├── plugin-contract.ts
│   ├── hydra.adapter.ts + hydra/cve-patterns.ts
│   ├── crow.adapter.ts (Beta-Binomial)
│   ├── djinn.adapter.ts (LCS drift)
│   ├── emu.adapter.ts (runway forecast)
│   ├── gorgon.adapter.ts (PageRank)
│   ├── lich.adapter.ts (M1 + M6 EMA)
│   ├── naga.adapter.ts (N1+N2+N3 fingerprint)
│   ├── pech.adapter.ts (ledger + thresholds)
│   └── sylph.adapter.ts (W5 + W2)
├── schematic.README.md (non-runtime per spec)
├── client/mcp-client.ts (high-level glue, JSON-RPC correlation)
└── index.ts
```

### Tests (6 → 18 files, ~2700 LOC, 136 passing / 7 todo)
```
tests/
├── orchestration/smoke.test.ts (3)
├── oauth/pkce-roundtrip.test.ts (7)
├── protocol/jsonrpc-validation.test.ts (12)  ← v0.2
├── security/
│   ├── tool-name-collision.test.ts (7)
│   ├── unbounded-resources.test.ts (4)
│   ├── ssrf-oauth-metadata.test.ts (18)  ← +6 IPv6
│   ├── hydra-args-array.test.ts (5)  ← v0.2
│   └── remaining-failure-modes.test.ts (10 real + 7 todo)
├── transport/streamable-http.test.ts (7)  ← v0.2
└── plugins/
    ├── crow.test.ts (8)
    ├── djinn.test.ts (5)
    ├── emu.test.ts (6)
    ├── gorgon.test.ts (6)
    ├── lich.test.ts (7)
    ├── naga.test.ts (6)
    ├── pech.test.ts (10)
    └── sylph.test.ts (9)
└── integration/end-to-end.test.ts (6)  ← v0.2 — real subprocess
└── fixtures/mock-mcp-server.mjs        ← v0.2 — Node JSON-RPC server
```

## What was removed at v0.2.1

**Browser dashboard (Vite + Preact UI)** — dropped because terminal + VS Code surfaces are in-context where developers work; the dashboard required active browser-tab visiting and got ignored. The WebSocket broadcaster (`src/observability/dashboard-server.ts`) stays — VS Code's webview consumes it. Notifier stays. Bus, orchestrator, plugins, transports unchanged.

Removed files:
- `dashboard/` — Vite + Preact browser UI (App.tsx, components, lib/ws-client.ts, styles.css, index.html, vite.config.ts, etc.)
- `scripts/run-dashboard.ts` — launcher that spawned Vite + the browser UI (217 LOC)

## v0.3 Follow-Ups (prioritized)

1. **OAuth replay defense** — nonce + freshness store. Currently audience binding is the only check. Surface: `src/oauth/nonce-store.ts`.
2. **Server spoofing (failure-mode 6)** — TLS cert pinning + Authorization-header response-origin check. Surface: `src/transport/tls-pin.ts`.
3. **Full trust-pin (failure-mode 10)** — SHA-256 over (command + args + binary digest + env allowlist + URL + per-tool schema digest). Surface: `src/registry/trust-pin.ts`.
4. **Lich M5 sandbox** — currently M1 static + M6 EMA. M5 requires sandbox runtime (Docker / nsjail / `vm` module).
5. **Djinn D2 HMM drift** — currently D1 LCS only. Adds Baum-Welch labeller for ON_TASK / SIDEQUEST / LOST.
6. **Pech file-backed ledger + L1 EMA forecast + L3 Z-score anomaly + L4 cache-waste** — currently in-memory.
7. **Gorgon Tarjan SCC + Python-AST extraction** — currently language-agnostic PageRank only.
8. **Bus depth-bounded derived-event recursion** — currently unbounded.
9. **Lifecycle full RequestContext propagation** — currently reconstructs minimal context per plugin invocation.
10. **Hydra HIGH severity → veto** — currently warns; configurable severity threshold.

## Run

```bash
cd client/enchanter
npm install
npm run typecheck
npm test
```

Expected: tsc clean, 130 passing / 7 todo / 0 fail.

## Audit Anchor (post-v0.2)

- **Files produced (count):** 40 TypeScript + 5 config + 1 IMPLEMENTATION_SUMMARY.md = 46
- **Files implemented vs stubbed:** 22 implemented / 1 stub (`schematic.README.md` per spec edge_case)
- **Tests passing vs todo:** 130 passing / 7 todo
- **Approved deps used:** typescript, vitest, zod, @opentelemetry/api, @opentelemetry/sdk-node, undici
- **Author-judgment count:** ~30 (each plugin's algorithmic simplifications + threshold choices documented inline)
- **Audit findings closed:** 3 of 3 high (IPv6 SSRF, JSON-RPC validation, hydra args-array); 1 critical was false positive (variable rename)
- **Highest-risk v0.3 follow-up:** OAuth replay nonce defense — current implementation has audience binding only.
