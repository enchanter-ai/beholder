# @enchanter-ai/plugin-naga

Structural replication via AST + TF-IDF + naming convention — the **Naga** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Naga runs in `trust-gate`, `post-response`, and `post-session`. It builds a triple-axis fingerprint (AST shape + TF-IDF term vector + naming convention) of session artifacts and detects structural drift across edits.

## Install

```bash
npm install beholder @enchanter-ai/plugin-naga
```

`beholder` is a peer dependency.

## Usage

```ts
import { nagaAdapter } from '@enchanter-ai/plugin-naga';
import { McpClient } from 'beholder';

const client = new McpClient({
  // ...transport, server config...
  plugins: [nagaAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
