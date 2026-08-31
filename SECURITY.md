# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.6.x | ✓ |
| < 0.6 | ✗ |

## Reporting a vulnerability

Report privately through GitHub Security Advisories on this repository
(**Security → Report a vulnerability**). Please do not open a public issue for a
suspected vulnerability. Include a reproduction and the affected component
(SDK path, Claude Code hook path, or inspector). We aim to acknowledge within a
few working days.

## Dependency advisories (triaged)

`npm audit` is reviewed as part of release. Current status for **v0.6.0**:

**Fixed**
- `ws` — bumped to `8.21.3` (out of the vulnerable `≤ 8.20.1` range). Direct runtime dependency.
- `uuid` — pinned via an `overrides` entry to `^11.1.1` (patches GHSA-w5hq-g745-h8pq, reached transitively through `node-notifier`).
- `@grpc/grpc-js` — resolved through a non-breaking `npm audit fix`.

**Known / accepted (tracked for a dedicated upgrade)**
- `@opentelemetry/core < 2.8.0` (W3C Baggage unbounded-memory allocation, GHSA-8988-4f7v-96qf) and its dependents, reached transitively through `@opentelemetry/sdk-node@0.55.0`. The only upstream fix is a **breaking** major bump to `@opentelemetry/sdk-node@0.221.0`, deferred to a dedicated OpenTelemetry upgrade rather than forced into this release. This chain is telemetry export only and is **not** on the security-critical veto path (`src/plugins/hydra/veto-core.mjs`), which has no third-party runtime dependencies.

The remaining `npm audit` entries are in the dev toolchain (test runner and build tooling) and do not ship in the published `files`.
