/* tests/security/tool-name-collision.test.ts — verifies architecture-spec
   phase_4 failure-mode 1 mitigation: namespace registry rejects bare-name
   resolution when 2+ servers export the same name. */

import { describe, it, expect } from 'vitest';
import {
  NamespaceRegistry,
  ToolNameCollisionError,
  ToolNotFoundError,
  SchemaDigestMismatchError,
} from '../../src/registry/namespace.js';

describe('failure-mode 1: tool-name collisions', () => {
  it('resolves a bare name when only one server exports it', () => {
    const reg = new NamespaceRegistry();
    reg.register('serverA', 'read_file', { description: 'reads a file' });
    const ident = reg.resolve('read_file');
    expect(ident.server_id).toBe('serverA');
    expect(ident.bare_name).toBe('read_file');
  });

  it('rejects a bare name when two servers export the same name', () => {
    const reg = new NamespaceRegistry();
    reg.register('serverA', 'read_file', { description: 'A reads a file' });
    reg.register('serverB', 'read_file', { description: 'B reads a file' });
    expect(() => reg.resolve('read_file')).toThrowError(ToolNameCollisionError);
  });

  it('resolves the qualified server_id.tool_name even when colliding bare', () => {
    const reg = new NamespaceRegistry();
    reg.register('serverA', 'read_file', { description: 'A' });
    reg.register('serverB', 'read_file', { description: 'B' });
    const a = reg.resolve('serverA.read_file');
    const b = reg.resolve('serverB.read_file');
    expect(a.server_id).toBe('serverA');
    expect(b.server_id).toBe('serverB');
    expect(a.schema_digest).not.toBe(b.schema_digest);
  });

  it('throws ToolNotFoundError for unknown qualified names', () => {
    const reg = new NamespaceRegistry();
    expect(() => reg.resolve('nope.thing')).toThrowError(ToolNotFoundError);
  });

  it('rejects schema mutation on re-registration (MCPoison defense)', () => {
    const reg = new NamespaceRegistry();
    reg.register('serverA', 'tool', { description: 'original' });
    expect(() => reg.register('serverA', 'tool', { description: 'mutated' })).toThrowError(
      SchemaDigestMismatchError,
    );
  });

  it('allows re-registration with identical schema (idempotent)', () => {
    const reg = new NamespaceRegistry();
    const schema = { description: 'same', inputSchema: { type: 'object' } };
    const a = reg.register('serverA', 'tool', schema);
    const b = reg.register('serverA', 'tool', schema);
    expect(a.schema_digest).toBe(b.schema_digest);
  });

  it('lists collision servers in error message for operator visibility', () => {
    const reg = new NamespaceRegistry();
    reg.register('foo', 'send', { description: 'foo' });
    reg.register('bar', 'send', { description: 'bar' });
    try {
      reg.resolve('send');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ToolNameCollisionError);
      const err = e as ToolNameCollisionError;
      expect(err.servers).toEqual(expect.arrayContaining(['foo', 'bar']));
    }
  });
});
