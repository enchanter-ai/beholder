# Enchanter event-schema (JSONL bridge)

Single source of truth for the wire format between the TypeScript runtime
(producer) and the Rust inspector (consumer). The Rust side reads JSONL —
one JSON object per line — over stdin, a regular file, or a TCP socket.
This doc pins what the TS bridge (`src/observability/bridge.ts`) writes
and what the Rust transport (`inspector/src/transport.rs`) accepts.

Rust ground truth: `inspector/src/event.rs` — variant tags, required
fields, and the `GenericPayload` fallback are defined there. If this doc
and that file disagree, that file wins; open a PR fixing the doc.

## Wire envelope

- One event per line, terminated by `\n`. `\r\n` is tolerated by the
  reader but the bridge writes `\n` only.
- UTF-8. Non-UTF-8 lines are dropped on the Rust side.
- Hard ceiling per line: **1 MiB** (matches `MAX_LINE_BYTES` in
  `inspector/src/transport.rs`). Producers stay well under 64 KiB in
  practice; the 1 MiB cap is a margin for unusually large `tool.result`
  payloads.
- Empty / blank lines are silently skipped.
- Malformed lines (invalid JSON or unknown `type`) are logged on the
  Rust side and skipped — one bad line never crashes the consumer.

## Required fields

Every event carries these two keys:

| Field  | Type   | Meaning |
|--------|--------|---------|
| `type` | string | Discriminator. Must match a known variant in `event.rs` (e.g. `runtime.metrics`, `tool.call`, `pech.ledger`) or one of the loose `GenericPayload` variants (e.g. `session.started`, `phase.entered`). |
| `time` | number | Wall-clock seconds since the Unix epoch. Floats with millisecond precision are normal. The TS bridge derives this as `event.ts / 1000` from the in-process bus's millisecond timestamp. |

## Common optional fields

These flow through the Rust `GenericPayload` shape and are also read off
the well-typed variants where the variant declares them:

| Field        | Type   | Notes |
|--------------|--------|-------|
| `session_id` | string | Originating session. Required on `task.updated`. |
| `task_id`    | string | Active task. Required on `task.updated`. |
| `plugin`     | string | Attribution: name of the producing plugin or `orchestrator`. |
| `phase`      | string | Lifecycle phase enum (see below). |
| `severity`   | string | Severity ladder (see below). |
| `message`    | string | Human-readable note. Free-form. |

Unknown extra keys round-trip through the Rust `GenericPayload.extra`
catch-all without loss — adding a new field on a `GenericPayload`
variant does not require a Rust change.

## Severity ladder

`debug | info | warning | high | critical` — lowercase, exact strings.
`hydra.veto` requires a severity; other variants treat it as optional.

## Phase enum

`anchor | trust-gate | pre-dispatch | dispatch | post-response |
post-session | cross-session`. Matches `LifecyclePhase` in
`src/orchestration/request-context.ts` and the `Phase` enum in
`inspector/src/event.rs`. Producers MUST use these literal strings.

## Well-typed variants

These variants have explicit Rust schemas. Required fields are listed;
the common optional fields above are accepted on top of them.

### `runtime.metrics`
Flat top-level fields:
`open_sessions, ongoing_tasks, queued_tasks, blocked_tasks,
code_written_lifetime_loc, code_modified_lifetime_loc,
files_created_lifetime, files_modified_lifetime, tool_calls_lifetime,
prs_created_lifetime, tests_run_lifetime, tests_passed_rate,
total_spend_lifetime, time` — all numeric.

### `tool.call`
Top-level: `tool` (string), `payload` (object with arbitrary tool
arguments). Optional: `session_id`, `task_id`, `phase`, `plugin`.

### `hydra.veto`
Top-level: `policy, reason, action, severity, payload` (any JSON
value). Optional: `session_id, plugin, phase, workspace, env`.

### `pech.ledger`
Top-level: `payload` (with `input_tokens, output_tokens, cost_usd,
session_cost_usd, daily_cost_usd`). Optional: `session_id, task_id,
phase, plugin`.

### `task.updated`
Top-level required: `task_id, session_id, age_seconds, time`.
Optional: `status, intent, file_or_area, phase, risk`.

### `code.modified`
Top-level required: `file, lines_added, lines_removed, lines_modified,
time`. Optional: `language, session_id, task_id`.

## GenericPayload variants

Everything else flows through `GenericPayload`: a flat shape carrying
the common optional fields plus an `extra` catch-all. Current Rust
list (snake_case `type` tags):

`session.started, session.opened, session.closed, session.ended,
phase.entered, phase.completed, plugin.loaded, plugin.health,
tool.result, tool.error, sylph.veto, crow.trust, djinn.anchor,
djinn.drift, gorgon.hotspot, naga.spec_check, lich.review,
emu.context_update, task.created, task.started, task.blocked,
task.completed, task.failed, code.generated, file.created,
file.modified, test.run, test.passed, test.failed, pr.created`.

Adding a new GenericPayload variant requires a Rust enum entry; adding
a new field to an existing one does not.

## TS bridge transform

The in-process bus carries `EnchantedEvent` (see
`src/bus/event-types.ts`) with a structured `payload` field. The
bridge serializes one event per line by:

1. Setting `type = event.topic`.
2. Setting `time = event.ts / 1000`.
3. Splatting `event.payload` into the top-level object.
4. Copying `session_id`, `phase` from the event onto the top level
   when not already present in the payload.
5. Copying `source` to `plugin` when payload has no `plugin` set.

This keeps the TS bus shape clean (structured payloads) while
producing the flat top-level shape Rust expects.

## Versioning

The `type` discriminator is the version axis. Renames are breaking;
field additions on `GenericPayload` are not. When adding a well-typed
variant, update both `inspector/src/event.rs` and this doc in the
same PR, plus a fixture line in
`inspector/tests/fixtures/bridge-roundtrip.jsonl` if the runtime
emits the variant.
