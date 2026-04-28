/* enchanter/src/transport/stdio.ts — implements architecture-spec
   phase_3.transports.stdio (MCP MUSTs: newline-delimited messages, UTF-8,
   no embedded newlines, JSON-RPC 2.0 envelope) and phase_4 failure-mode 5
   (unbounded resources — body cap 8MB before parse).
   Counter: a length-prefixed framing would be more robust against newline
   injection but the MCP spec mandates newline framing — we honor the spec. */

import type { Readable, Writable } from 'node:stream';
import { parseJsonRpc, serializeJsonRpc, type JsonRpcMessage } from '../protocol/jsonrpc.js';

export const PER_MESSAGE_BODY_MAX_BYTES = 8 * 1024 * 1024; // 8 MB cap

export class BodyTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`stdio message body exceeded cap (${bytes} > ${PER_MESSAGE_BODY_MAX_BYTES} bytes)`);
    this.name = 'BodyTooLargeError';
  }
}

export class StdioTransport {
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  async send(msg: JsonRpcMessage): Promise<void> {
    const json = serializeJsonRpc(msg);
    const line = json + '\n';
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > PER_MESSAGE_BODY_MAX_BYTES) {
      throw new BodyTooLargeError(bytes);
    }
    await new Promise<void>((resolve, reject) => {
      this.output.write(line, 'utf8', (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Async iterator yielding parsed JSON-RPC messages from stdin. */
  async *recv(): AsyncIterableIterator<JsonRpcMessage> {
    let buffer = Buffer.alloc(0);
    for await (const chunk of this.input as AsyncIterable<Buffer>) {
      // Defense-in-depth body cap before parse (failure-mode 5).
      if (buffer.length + chunk.length > PER_MESSAGE_BODY_MAX_BYTES) {
        throw new BodyTooLargeError(buffer.length + chunk.length);
      }
      buffer = Buffer.concat([buffer, chunk]);

      let nlIndex: number;
      // eslint-disable-next-line no-cond-assign
      while ((nlIndex = buffer.indexOf(0x0a)) !== -1) {
        const lineBuf = buffer.subarray(0, nlIndex);
        buffer = buffer.subarray(nlIndex + 1);
        if (lineBuf.length === 0) continue; // skip empty lines
        if (lineBuf.length > PER_MESSAGE_BODY_MAX_BYTES) {
          throw new BodyTooLargeError(lineBuf.length);
        }
        const line = lineBuf.toString('utf8');
        yield parseJsonRpc(line);
      }
    }
    // Tail without newline is treated as malformed — we drop silently per
    // robustness to truncated streams. Audit-log layer records dropped bytes.
  }
}
