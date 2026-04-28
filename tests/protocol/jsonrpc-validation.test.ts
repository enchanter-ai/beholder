/* tests/protocol/jsonrpc-validation.test.ts — verifies the audit-driven
   field-shape validation in parseJsonRpc (rejects malformed messages from
   misbehaving servers before they reach plugin dispatch). */

import { describe, it, expect } from 'vitest';
import { parseJsonRpc, JsonRpcParseError } from '../../src/protocol/jsonrpc.js';

describe('parseJsonRpc field-shape validation', () => {
  it('accepts a well-formed request', () => {
    const msg = parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    expect((msg as { method: string }).method).toBe('tools/list');
  });

  it('accepts a well-formed response', () => {
    const msg = parseJsonRpc('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    expect((msg as { id: number }).id).toBe(1);
  });

  it('accepts a well-formed notification (no id)', () => {
    const msg = parseJsonRpc('{"jsonrpc":"2.0","method":"notifications/cancelled"}');
    expect((msg as { method: string }).method).toBe('notifications/cancelled');
  });

  it('rejects missing jsonrpc field', () => {
    expect(() => parseJsonRpc('{"id":1,"method":"tools/list"}')).toThrowError(JsonRpcParseError);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(() => parseJsonRpc('{"jsonrpc":"1.0","id":1,"method":"x"}')).toThrowError(
      JsonRpcParseError,
    );
  });

  it('rejects non-string method', () => {
    expect(() => parseJsonRpc('{"jsonrpc":"2.0","id":1,"method":123}')).toThrowError(
      JsonRpcParseError,
    );
  });

  it('rejects object id', () => {
    expect(() => parseJsonRpc('{"jsonrpc":"2.0","id":{},"method":"x"}')).toThrowError(
      JsonRpcParseError,
    );
  });

  it('rejects boolean id', () => {
    expect(() => parseJsonRpc('{"jsonrpc":"2.0","id":true,"method":"x"}')).toThrowError(
      JsonRpcParseError,
    );
  });

  it('accepts null id (notification-shaped response)', () => {
    const msg = parseJsonRpc('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"x"}}');
    expect((msg as { id: null }).id).toBeNull();
  });

  it('rejects error without numeric code', () => {
    expect(() =>
      parseJsonRpc('{"jsonrpc":"2.0","id":1,"error":{"code":"oops","message":"x"}}'),
    ).toThrowError(JsonRpcParseError);
  });

  it('rejects error without string message', () => {
    expect(() =>
      parseJsonRpc('{"jsonrpc":"2.0","id":1,"error":{"code":-32600}}'),
    ).toThrowError(JsonRpcParseError);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseJsonRpc('{not-json')).toThrowError(JsonRpcParseError);
  });
});
