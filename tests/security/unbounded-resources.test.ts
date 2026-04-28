/* tests/security/unbounded-resources.test.ts — verifies architecture-spec
   phase_4 failure-mode 5 mitigation: stdio transport caps body at 8MB
   before parse (CVE-2026-39313 mcp-framework readRequestBody class). */

import { describe, it, expect } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { StdioTransport, BodyTooLargeError, PER_MESSAGE_BODY_MAX_BYTES } from '../../src/transport/stdio.js';

function readableFrom(chunks: Buffer[]): Readable {
  let i = 0;
  return new Readable({
    read() {
      if (i < chunks.length) this.push(chunks[i++]);
      else this.push(null);
    },
  });
}

function devNullWritable(): Writable {
  return new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
}

describe('failure-mode 5: unbounded resources', () => {
  it('exposes the documented 8MB cap', () => {
    expect(PER_MESSAGE_BODY_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('rejects a single chunk exceeding the body cap', async () => {
    const oversized = Buffer.alloc(PER_MESSAGE_BODY_MAX_BYTES + 1, 0x20); // spaces, no newline
    const transport = new StdioTransport(readableFrom([oversized]), devNullWritable());
    await expect(async () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of transport.recv()) {
        // never reached
      }
    }).rejects.toThrowError(BodyTooLargeError);
  });

  it('rejects accumulated chunks exceeding the body cap before a newline appears', async () => {
    const half = Buffer.alloc(PER_MESSAGE_BODY_MAX_BYTES / 2 + 1, 0x20);
    const transport = new StdioTransport(readableFrom([half, half]), devNullWritable());
    await expect(async () => {
      for await (const _ of transport.recv()) {
        // never reached
      }
    }).rejects.toThrowError(BodyTooLargeError);
  });

  it('accepts a normal-sized JSON-RPC line', async () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    const transport = new StdioTransport(readableFrom([Buffer.from(msg, 'utf8')]), devNullWritable());
    const messages = [];
    for await (const m of transport.recv()) messages.push(m);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { method?: string }).method).toBe('tools/list');
  });
});
