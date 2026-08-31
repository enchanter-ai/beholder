# @enchanter-ai/plugin-crow

Bayesian trust scoring + info-gain review ordering — the **Crow** adapter for [Beholder](https://github.com/enchanter-ai/beholder).

Crow maintains a Beta posterior per source / tool / pattern, scores trust as the posterior mean, and orders pending reviews by expected information gain (entropy reduction).

## Install

```bash
npm install beholder @enchanter-ai/plugin-crow
```

`beholder` is a peer dependency.

## Usage

```ts
import { crowAdapter } from '@enchanter-ai/plugin-crow';
import { McpClient } from 'beholder';

const client = new McpClient({
  // ...transport, server config...
  plugins: [crowAdapter],
});
```

See the root [Beholder README](https://github.com/enchanter-ai/beholder#readme) for the full lifecycle and plugin contract.

## License

Apache-2.0
