/* @enchanter-ai/plugin-pech — thin re-export shell.
   Canonical implementation lives in the root `beholder` package at
   src/plugins/pech.adapter.ts; this package republishes those symbols
   under the @enchanter-ai/plugin-pech name so consumers can install
   the cost-ledger plugin standalone with `beholder` as a peer. */

export { pechAdapter } from 'beholder';
