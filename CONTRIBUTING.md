# Contributing to Enchanter

Thanks for your interest. This repo holds the **Enchanter SDK** — the TypeScript agent framework with native MCP support. The 10 capability plugins and Wixie (prompt engine) are sibling repos in the same GitHub org.

## Project structure (across the org)

| Repo | What it is | Language |
|---|---|---|
| **`enchanter-ai/enchanter`** (this repo) | The SDK + MCP client | TypeScript |
| `enchanter-ai/wixie` | Prompt-engineering meta-engine (research → craft → converge → harden → translate) | Python + Markdown |
| `enchanter-ai/{crow,djinn,emu,gorgon,hydra,lich,naga,pech,schematic,sylph}` | 10 capability plugins (Claude Code skills + Python algorithms) | Python + Markdown SKILL.md |

The TypeScript adapters in this repo at `src/plugins/*.adapter.ts` port each plugin's algorithm into the SDK runtime. The sibling repos hold the original Python implementations + Claude Code skill definitions and evolve on their own cadence.

## Development setup

```bash
git clone https://github.com/enchanter-ai/enchanter
cd enchanter
npm install
npm run typecheck
npm test
```

Live demo against a real MCP server:

```bash
npx tsx scripts/demo-live.ts
```

## What needs work

See [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) for the prioritized v0.3 follow-ups. The 5 highest-impact items:

1. **OAuth replay defense** — nonce + freshness store. Currently audience-binding only.
2. **Server spoofing (FM 6)** — TLS cert pinning + Authorization-header response-origin check.
3. **Full trust-pin (FM 10)** — SHA-256 over (cmd + args + binary digest + env + URL + schema).
4. **Lich M5 sandbox** — currently M1 static + M6 EMA only.
5. **Djinn D2 HMM drift** — currently D1 LCS only.

## Plugin-authoring conventions

Every plugin honors the `shared/conduct/*.md` modules referenced in its `CLAUDE.md`. The 13 modules cover discipline, context hygiene, verification, delegation, failure-mode taxonomy, tool-use, formatting, skill-authoring, hooks, precedent, tier-sizing, web-fetch, and the inference substrate.

Within the Enchanter SDK, plugin adapters live at `src/plugins/<name>.adapter.ts`. Each adapter implements the `PluginAdapter` interface from `src/plugins/plugin-contract.ts`:

```typescript
export interface PluginAdapter {
  readonly name: string;
  readonly phases: ReadonlyArray<LifecyclePhase>;
  readonly required: boolean;        // fail-closed (true) vs fail-open with degraded=true (false)
  readonly topics: { subscribes: ReadonlyArray<string>; emits: ReadonlyArray<string> };
  readonly budget_tier: 'always' | 'med-or-higher' | 'high-only';
  onPhase(event: EnchantedEvent, ctx: RequestContext): Promise<PluginAck>;
}
```

Required reading before submitting a plugin PR:
- The full architecture spec lives in the Wixie repo at `prompts/mcp-client-golden-architecture/output-opus-4-7.json` — clone [enchanter-ai/wixie](https://github.com/enchanter-ai/wixie) to read it.
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) — v0.2 status
- The reference plugin: [src/plugins/hydra.adapter.ts](src/plugins/hydra.adapter.ts)

## Code conduct

These behavioral modules apply to all code across the Enchanter project. Each lives at `shared/conduct/*.md` in the [enchanter-ai/wixie](https://github.com/enchanter-ai/wixie) repo and is referenced from each plugin's `CLAUDE.md`:

- **discipline** — think-first, simplicity, surgical edits, goal-driven loops
- **verification** — independent checks, baseline snapshots, dry-run for destructive ops
- **delegation** — subagent contracts, tool whitelisting, parallel vs serial rules
- **failure-modes** — 14-code taxonomy (F01 sycophancy through F14 version drift)
- **tool-use** — tool-choice hygiene, error payload contract, parallel dispatch
- **precedent** — log self-observed failures so future agents don't repeat them

## Submitting changes

1. Fork the relevant repo (this repo for SDK changes; sibling repos at [enchanter-ai/<plugin>](https://github.com/enchanter-ai) for plugin algorithm or skill changes).
2. Create a feature branch.
3. Add or update tests — every implemented file cites a specific architecture-spec section in its top comment.
4. Run `npm test` (or the plugin's local test command) and ensure green.
5. Open a PR with a one-paragraph "what changed and why."

## License

By contributing you agree your contributions are licensed under Apache 2.0 (see [LICENSE](LICENSE)).
