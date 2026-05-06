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
