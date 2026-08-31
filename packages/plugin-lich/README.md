# @enchanter-ai/plugin-lich

Code review with sandboxed confirmation + Bayesian preference — the **Lich** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Lich runs in `post-response`. It pattern-matches suspicious tool results, optionally confirms findings inside a sandbox, and tracks per-pattern false-positive rates via Bayesian preference learning.

## Install

```bash
npm install beholder @enchanter-ai/plugin-lich
```

`beholder` is a peer dependency.

## Usage

```ts
import { lichAdapter, configureLich } from '@enchanter-ai/plugin-lich';
import { McpClient } from 'beholder';

const client = new McpClient({
  // ...transport, server config...
  plugins: [lichAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
