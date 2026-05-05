/* tests/observability/bridge-config.test.ts — unit tests for the
 * ENCHANTER_BRIDGE env var parser + sink factory. Coverage:
 *   - every accepted form parses to the expected spec
 *   - invalid forms throw with a useful message containing the bad value
 *     and at least one example
 *   - makeSinkFromEnv returns the right sink class (or null for 'off')
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseBridgeEnv, makeSinkFromEnv } from '../../src/observability/bridge-config.js';
import { StdoutSink, FileSink, TcpSink } from '../../src/observability/bridge.js';

describe('parseBridgeEnv', () => {
  it("returns { kind: 'off' } when env var is unset", () => {
    expect(parseBridgeEnv(undefined)).toEqual({ kind: 'off' });
  });

  it("returns { kind: 'off' } for empty / whitespace / 'off' / 'OFF'", () => {
    expect(parseBridgeEnv('')).toEqual({ kind: 'off' });
    expect(parseBridgeEnv('   ')).toEqual({ kind: 'off' });
    expect(parseBridgeEnv('off')).toEqual({ kind: 'off' });
    expect(parseBridgeEnv('OFF')).toEqual({ kind: 'off' });
  });

  it("parses 'stdout' (case-insensitive)", () => {
    expect(parseBridgeEnv('stdout')).toEqual({ kind: 'stdout' });
    expect(parseBridgeEnv('STDOUT')).toEqual({ kind: 'stdout' });
  });

  it('parses tcp://host:port', () => {
    expect(parseBridgeEnv('tcp://127.0.0.1:7878')).toEqual({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 7878,
    });
  });

  it('parses tcp://host:port with trailing slash', () => {
    expect(parseBridgeEnv('tcp://localhost:9000/')).toEqual({
      kind: 'tcp',
      host: 'localhost',
      port: 9000,
    });
  });

  it('parses tcp:// with hostname (not just IP)', () => {
    expect(parseBridgeEnv('tcp://inspector.local:4242')).toEqual({
      kind: 'tcp',
      host: 'inspector.local',
      port: 4242,
    });
  });

  it('parses file:///absolute/path (POSIX)', () => {
    expect(parseBridgeEnv('file:///var/log/run.jsonl')).toEqual({
      kind: 'file',
      path: '/var/log/run.jsonl',
    });
  });

  it('parses file:///C:/path (Windows drive letter)', () => {
    expect(parseBridgeEnv('file:///C:/logs/run.jsonl')).toEqual({
      kind: 'file',
      path: 'C:/logs/run.jsonl',
    });
  });

  it('parses file:./relative/path', () => {
    expect(parseBridgeEnv('file:./run-2026.jsonl')).toEqual({
      kind: 'file',
      path: './run-2026.jsonl',
    });
    expect(parseBridgeEnv('file:relative.jsonl')).toEqual({
      kind: 'file',
      path: 'relative.jsonl',
    });
  });

  it('throws on unknown scheme', () => {
    expect(() => parseBridgeEnv('http://localhost:7878')).toThrow(
      /invalid ENCHANTER_BRIDGE/,
    );
    expect(() => parseBridgeEnv('http://localhost:7878')).toThrow(/examples/);
  });

  it('throws on bare hostname (no scheme)', () => {
    expect(() => parseBridgeEnv('127.0.0.1:7878')).toThrow(
      /invalid ENCHANTER_BRIDGE/,
    );
  });

  it('throws on tcp:// with missing port', () => {
    expect(() => parseBridgeEnv('tcp://127.0.0.1')).toThrow(
      /invalid ENCHANTER_BRIDGE/,
    );
  });

  it('throws on tcp:// with non-numeric port', () => {
    expect(() => parseBridgeEnv('tcp://127.0.0.1:abc')).toThrow(
      /invalid ENCHANTER_BRIDGE/,
    );
  });

  it('throws on tcp:// with out-of-range port', () => {
    expect(() => parseBridgeEnv('tcp://127.0.0.1:99999')).toThrow(
      /invalid ENCHANTER_BRIDGE/,
    );
  });

  it('throws on file:// with empty path', () => {
    expect(() => parseBridgeEnv('file://')).toThrow(/invalid ENCHANTER_BRIDGE/);
    expect(() => parseBridgeEnv('file:')).toThrow(/invalid ENCHANTER_BRIDGE/);
  });

  it('error message names the offending value', () => {
    let msg = '';
    try {
      parseBridgeEnv('garbage://nope');
    } catch (err) {
      msg = err instanceof Error ? err.message : String(err);
    }
    expect(msg).toContain('garbage://nope');
  });
});

describe('makeSinkFromEnv', () => {
  it("returns null for 'off'", () => {
    expect(makeSinkFromEnv({ kind: 'off' })).toBeNull();
  });

  it("returns a StdoutSink for 'stdout'", () => {
    const sink = makeSinkFromEnv({ kind: 'stdout' });
    expect(sink).toBeInstanceOf(StdoutSink);
  });

  it('returns a FileSink for file specs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'enchanter-bridge-cfg-'));
    const path = join(dir, 'out.jsonl');
    try {
      const sink = makeSinkFromEnv({ kind: 'file', path });
      expect(sink).toBeInstanceOf(FileSink);
      // Close the underlying stream so the tempdir cleanup succeeds on Windows.
      void sink?.end();
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* tempfile cleanup is best-effort */
      }
    }
  });

  it('returns a TcpSink for tcp specs', () => {
    // The TcpSink begins connecting immediately; we tear it down before
    // the connection attempt resolves to avoid leaving a dangling timer.
    const sink = makeSinkFromEnv({ kind: 'tcp', host: '127.0.0.1', port: 1 });
    expect(sink).toBeInstanceOf(TcpSink);
    void sink?.end();
  });
});
