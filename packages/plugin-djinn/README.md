# @enchanter-ai/plugin-djinn

Intent anchoring + drift detection across `/compact` — the **Djinn** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Djinn captures a session anchor at the start of a request and detects drift between the user's stated intent and the actual sequence of tool calls — including across `/compact` boundaries that erase short-term context.

## Install

```bash
npm install beholder @enchanter-ai/plugin-djinn
```

`beholder` is a peer dependency.

## Usage

```ts
import { djinnAdapter } from '@enchanter-ai/plugin-djinn';
import { McpClient } from 'beholder';

const client = new McpClient({
  // ...transport, server config...
  plugins: [djinnAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
