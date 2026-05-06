# Claude Code → Enchanter Inspector

Wire your real Claude Code work into the Enchanter inspector cockpit. No demo
loop, no synthetic data — when you're using Claude Code, the inspector shows
your actual tool calls, durations, costs, and lifecycle phases.

## Why

The inspector renders ten live views over a JSONL event stream. The bridge
already knows how to translate enchanter's in-process bus into that wire
format — but if you're driving real work through Claude Code itself, you want
those events to land in the same stream. This integration installs a Claude
Code session hook that emits to a local JSONL file the inspector can tail.

## Install

From a checkout of the `enchanter` package:

```bash
node scripts/hooks/install-hooks.mjs
```

The installer is idempotent — re-running won't duplicate entries. It edits
`~/.claude/settings.json` and adds one entry per hook event pointing at
`scripts/hooks/claude-code-emit.mjs`.

## Launch the inspector

```bash
enchanter inspect --tail ~/.cache/enchanter/claude-code.jsonl
```

On Windows the path is `%LOCALAPPDATA%\enchanter\claude-code.jsonl`. The
emitter resolves the cache base the same way the inspector does:
`XDG_CACHE_HOME` → `LOCALAPPDATA` → `HOME/.cache` → tmpdir, all under an
`enchanter/` subdir.

## Hook event → wire event mapping

| Hook event         | Bridge event(s)                                                       |
|--------------------|-----------------------------------------------------------------------|
| `SessionStart`     | `session.started`                                                     |
| `UserPromptSubmit` | `lifecycle.anchor` (phase=anchor, plugin=orchestrator)                |
| `PreToolUse`       | `mcp.tool.call.requested` (phase=trust-gate, plugin=mcp-client)       |
| `PostToolUse`      | `mcp.tool.result.received` (phase=post-response, plugin=mcp-client)   |
|                    | `pech.ledger.appended` (when usage info is present in the response)   |
| `SubagentStop`     | `task.completed`                                                      |
| `Stop`             | `lifecycle.post-session` (phase=post-session)                         |
| `SessionEnd`       | `session.closed`                                                      |
| `PreCompact`       | `phase.entered` (phase=cross-session, plugin=compactor)               |

## Derived plugin events

Each hook also emits derived events that drive the cockpit's PLUGINS table
from real session activity. These are computed from a per-session state
file at `~/.cache/enchanter/plugin-state.json` (or `%LOCALAPPDATA%\...` on
Windows) that accumulates tool counts, error counts, file access, and the
session anchor across hook firings. The state file is rewritten atomically
(write tmp + rename) and reset on `SessionEnd`.

| Hook                | Derived event(s)                                                       |
|---------------------|------------------------------------------------------------------------|
| `UserPromptSubmit`  | `djinn.anchor.set` (first prompt only) — locks `anchor_intent` (≤200 chars) |
|                     | `djinn.drift.observed` (subsequent prompts) — word-overlap drift vs. anchor, capped at 0.5 |
|                     | `emu.context_update` — `turn_estimate = max(12, 200 - turn_count)`, `context_size = prompt_chars` |
| `PreToolUse`        | `crow.trust.scored` — `posterior_mean = 1 - errors/total` per tool, `observation_count = total` |
| `PostToolUse`       | `gorgon.hotspot` — top file by access count, `heat = count/total`. **Rate-limited to once every 5 PostToolUse events** to avoid flooding |
|                     | `naga.spec_check` — Edit/Write only. **Stub-clean verdict** — real algorithm requires diff parsing (deferred to a future release) |
|                     | `lich.review` — Edit/Write only. **Stub-clean verdict** — same caveat as naga |

### Notes

- **emu's "turns left"**: derived from `200 - turn_count` where `turn_count`
  is the number of `UserPromptSubmit` events seen this session. The 200-turn
  budget is hardcoded; v0.7 will pull session quotas from `~/.claude.json`.
- **gorgon rate-limit**: 5-event cadence chosen to balance signal vs. noise.
  Edit/Write/Read activity tends to cluster, so emitting on every PostToolUse
  would spam the cockpit; less frequent than 5 makes the heat-map feel stale.
- **naga + lich are stubs**: both emit `status: "clean"` unconditionally
  on Edit/Write. The real algorithms (drift detection vs. spec, sandbox-depth
  audit) need the actual diff content, which the hook payload doesn't provide
  in a usable form. Verdicts are visual placeholders until the diff parser
  lands.
- **crow trust accumulates within a session**: the posterior is reset every
  time the cache file disappears (SessionEnd, manual delete). Cross-session
  trust would need a second persistent store — out of scope for v0.6.

## Disable

Re-run the installer with `--uninstall`:

```bash
node scripts/hooks/install-hooks.mjs --uninstall
```

Or hand-edit `~/.claude/settings.json` and remove the entries whose `command`
strings contain `enchanter:claude-code-emit`.

## Privacy

- Tool arguments and outputs are truncated to fit a 16 KB per-event cap.
- The emitter writes to a local file under your cache dir. Nothing is sent
  over the network.
- The emitter never writes to stdout (Claude Code captures stdout into its
  own message stream); diagnostic errors land in a sibling `claude-code.err`
  file in the same cache dir.
- The emitter always exits 0 — a hook failure can't block your Claude Code
  session.

## Troubleshooting

- **No events showing up:** confirm `~/.claude/settings.json` lists the hook
  entries. Run `claude` once after install so the settings are picked up.
- **Errors:** check `~/.cache/enchanter/claude-code.err` (Linux/Mac) or
  `%LOCALAPPDATA%\enchanter\claude-code.err` (Windows).
- **File grew large:** the emitter rotates at 5 MB to a `.1` sibling.
