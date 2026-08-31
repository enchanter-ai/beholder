# @enchanter-ai/plugin-emu

Token economy monitor + ±CI runway forecast — the **Emu** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Emu observes per-call token usage and emits a remaining-runway forecast with a confidence interval. Runs in the `pre-dispatch` and `post-response` lifecycle phases.

## Install

```bash
npm install beholder @enchanter-ai/plugin-emu
```

`beholder` is a peer dependency.

## Usage

```ts
import { emuAdapter, configureEmu } from '@enchanter-ai/plugin-emu';
import { McpClient } from 'beholder';

configureEmu({ remaining_budget: 1_000_000 });

const client = new McpClient({
  // ...transport, server config...
  plugins: [emuAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
