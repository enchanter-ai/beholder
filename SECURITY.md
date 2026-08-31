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

`npm audit` is reviewed as part of release. As of **v0.6.0**, both
`npm audit` and `npm audit --omit=dev` report **0 vulnerabilities**.

How that was reached:
- Removed the unused `@opentelemetry/api` and `@opentelemetry/sdk-node`
  dependencies — declared but imported nowhere in `src/` or `scripts/`. This
  cleared the entire OpenTelemetry advisory chain (including a critical) at the
  root rather than deferring it.
- `ws` `8.20.0 → 8.21.3` and `undici` `7.25.0 → 7.29.0` (direct runtime
  dependencies; both out of their vulnerable ranges).
- `overrides`: `uuid ^11.1.1` (patches GHSA-w5hq-g745-h8pq via `node-notifier`)
  and `esbuild ^0.28.2` (dev-server file-read advisory via the test toolchain).
- `vitest` `2 → 4` for the remaining test-runner advisories.

The security-critical veto core (`src/plugins/hydra/veto-core.mjs`) has **no**
third-party runtime dependencies — it is stdlib-only ESM so the Claude Code
hook can import it directly.
