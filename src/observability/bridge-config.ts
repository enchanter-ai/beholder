/* src/observability/bridge-config.ts — parse the ENCHANTER_BRIDGE env var
 * into a BridgeSink. The runtime calls parseBridgeEnv() once at startup
 * and, if the result is not 'off', constructs the matching sink via
 * makeSinkFromEnv() and hands it to a Bridge.
 *
 * Accepted forms:
 *   unset / empty / 'off'        → { kind: 'off' }
 *   'stdout'                     → { kind: 'stdout' }
 *   'tcp://host:port[/]'         → { kind: 'tcp', host, port }
 *   'file:///abs/path'           → { kind: 'file', path: '/abs/path' }
 *   'file:./relative/path'       → { kind: 'file', path: './relative/path' }
 *   anything else                → throws Error with a short example list
 *
 * Uses node:url for tcp:// parsing; file: forms are matched by prefix to
 * preserve the relative-path contract that the URL parser would reject.
 */

import { URL } from 'node:url';
import { type BridgeSink, StdoutSink, FileSink, TcpSink } from './bridge.js';

export type BridgeEnvSpec =
  | { kind: 'stdout' }
  | { kind: 'file'; path: string }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'off' };

const EXAMPLES =
  "examples: 'stdout', 'tcp://127.0.0.1:7878', 'file:///abs/log.jsonl', 'file:./relative.jsonl'";

function fail(value: string): never {
  throw new Error(`invalid ENCHANTER_BRIDGE: ${value} — ${EXAMPLES}`);
}

export function parseBridgeEnv(value: string | undefined): BridgeEnvSpec {
  if (value === undefined) return { kind: 'off' };
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'off') return { kind: 'off' };
  if (trimmed.toLowerCase() === 'stdout') return { kind: 'stdout' };

  if (trimmed.startsWith('tcp://')) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      fail(value);
    }
    const host = parsed.hostname;
    const port = Number(parsed.port);
    if (!host || !Number.isInteger(port) || port <= 0 || port > 65535) {
      fail(value);
    }
    return { kind: 'tcp', host, port };
  }

  // Absolute file URL: file:///abs/path. The third slash starts the path.
  if (trimmed.startsWith('file:///')) {
    const rest = trimmed.slice('file://'.length); // keeps the leading '/'
    // Drop the leading '/' on Windows-drive forms ('/C:/foo' → 'C:/foo').
    const path = /^\/[A-Za-z]:[\/\\]/.test(rest) ? rest.slice(1) : rest;
    if (path === '' || path === '/') fail(value);
    return { kind: 'file', path };
  }

  // Relative file URL: file:./relative/path  (no double slash). This shape
  // is non-standard but is part of the documented contract — used to make
  // it obvious in scripts that the path is relative to cwd.
  if (trimmed.startsWith('file:')) {
    const path = trimmed.slice('file:'.length);
    if (path === '' || path.startsWith('//')) fail(value);
    return { kind: 'file', path };
  }

  fail(value);
}

export function makeSinkFromEnv(spec: BridgeEnvSpec): BridgeSink | null {
  switch (spec.kind) {
    case 'off':
      return null;
    case 'stdout':
      return new StdoutSink();
    case 'file':
      return new FileSink(spec.path);
    case 'tcp':
      return new TcpSink(spec.host, spec.port);
  }
}
