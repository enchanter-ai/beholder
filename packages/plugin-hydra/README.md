# @enchanter-ai/plugin-hydra

Real-time CVE-anchored security interception — the **Hydra** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Hydra runs in the `trust-gate` and `post-response` lifecycle phases. It vetos calls matching destructive-op patterns, masks secrets (AWS keys, bearer tokens, PEM blocks) in tool results, and emits findings tagged with the matched CVE ID.

## Install

```bash
npm install beholder @enchanter-ai/plugin-hydra
```

`beholder` is a peer dependency.

## Usage

```ts
import { hydraAdapter, configureHydra, maskSecrets, matchCvePatterns } from '@enchanter-ai/plugin-hydra';
import { McpClient } from 'beholder';

const client = new McpClient({
  // ...transport, server config...
  plugins: [hydraAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
