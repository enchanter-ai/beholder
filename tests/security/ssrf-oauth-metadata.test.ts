/* tests/security/ssrf-oauth-metadata.test.ts — verifies architecture-spec
   phase_4 failure-mode 7 mitigation: OAuth metadata fetcher rejects RFC 1918
   / link-local / cloud metadata IPs / localhost / non-HTTPS remote. */

import { describe, it, expect } from 'vitest';
import { validateMetadataUrl, SsrfRejectionError } from '../../src/oauth/metadata-validator.js';

describe('failure-mode 7: SSRF via OAuth metadata', () => {
  it('accepts a normal HTTPS URL', () => {
    const url = validateMetadataUrl('https://auth.example.com/.well-known/oauth-authorization-server');
    expect(url.hostname).toBe('auth.example.com');
  });

  it('rejects plain HTTP by default', () => {
    expect(() => validateMetadataUrl('http://auth.example.com/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects localhost by default', () => {
    expect(() => validateMetadataUrl('https://localhost/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects RFC 1918 10.0.0.0/8', () => {
    expect(() => validateMetadataUrl('https://10.0.0.5/meta')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('https://10.255.255.255/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects RFC 1918 172.16.0.0/12', () => {
    expect(() => validateMetadataUrl('https://172.16.0.1/meta')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('https://172.31.255.255/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects RFC 1918 192.168.0.0/16', () => {
    expect(() => validateMetadataUrl('https://192.168.1.1/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects link-local 169.254.0.0/16', () => {
    expect(() => validateMetadataUrl('https://169.254.1.1/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects cloud metadata endpoint 169.254.169.254', () => {
    expect(() => validateMetadataUrl('https://169.254.169.254/latest/meta-data/')).toThrowError(
      SsrfRejectionError,
    );
  });

  it('rejects loopback 127.x', () => {
    expect(() => validateMetadataUrl('https://127.0.0.1/meta')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('https://127.1.2.3/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects malformed URLs', () => {
    expect(() => validateMetadataUrl('not-a-url')).toThrowError(SsrfRejectionError);
  });

  it('rejects non-HTTP schemes', () => {
    expect(() => validateMetadataUrl('file:///etc/passwd')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('ftp://example.com/')).toThrowError(SsrfRejectionError);
  });

  it('allows loopback when explicitly opted in (dev override)', () => {
    const url = validateMetadataUrl('https://127.0.0.1/meta', { allowLoopback: true });
    expect(url.hostname).toBe('127.0.0.1');
  });

  // IPv6 — audit hardening (was previously only ::1)
  it('rejects IPv6 loopback ::1', () => {
    expect(() => validateMetadataUrl('https://[::1]/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects IPv4-mapped IPv6 cloud-metadata endpoint ::ffff:169.254.169.254', () => {
    expect(() => validateMetadataUrl('https://[::ffff:169.254.169.254]/meta')).toThrowError(
      SsrfRejectionError,
    );
  });

  it('rejects IPv4-mapped IPv6 RFC 1918 ::ffff:10.0.0.1', () => {
    expect(() => validateMetadataUrl('https://[::ffff:10.0.0.1]/meta')).toThrowError(
      SsrfRejectionError,
    );
  });

  it('rejects IPv6 link-local fe80::/10', () => {
    expect(() => validateMetadataUrl('https://[fe80::1]/meta')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('https://[feb0::1]/meta')).toThrowError(SsrfRejectionError);
  });

  it('rejects IPv6 unique-local fc00::/7', () => {
    expect(() => validateMetadataUrl('https://[fc00::1]/meta')).toThrowError(SsrfRejectionError);
    expect(() => validateMetadataUrl('https://[fd12:3456::1]/meta')).toThrowError(SsrfRejectionError);
  });

  it('accepts a public IPv6 address by default', () => {
    const url = validateMetadataUrl('https://[2606:4700:4700::1111]/meta');
    expect(url.hostname).toBe('[2606:4700:4700::1111]');
  });
});
