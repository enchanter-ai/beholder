# schematic — non-runtime governance

Per architecture-spec `phase_1_plugin_role_mapping[8]`: schematic is the **template seed**, not a runtime plugin. It does NOT intercept MCP requests.

In an MCP-client context, schematic's role is:
- The structural source-of-truth that naga's N1+N2+N3 fingerprinting compares against during plugin onboarding (see `plugin.onboarding.requested` event flow).
- The home of `shared/conduct/*.md` modules every plugin inherits.

There is intentionally no `schematic.adapter.ts`. If a future v0.2 escalates schematic to runtime governance (e.g., emitting `schematic.conduct.violation` events at session start), it would land here.

See architecture-spec `open_questions[9]` — production telemetry over 30 days will tell us whether schematic should be promoted.
