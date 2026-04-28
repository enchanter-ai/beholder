/* tests/oauth/pkce-roundtrip.test.ts — verifies architecture-spec
   phase_3.oauth_2_1_pkce_rfc_8707_flow steps 3-5 (S256 PKCE per RFC 7636,
   MCP MUST per spec citation S6). */

import { describe, it, expect } from 'vitest';
import {
  generateCodeVerifier,
  deriveS256Challenge,
  verifyS256,
  validateVerifier,
} from '../../src/oauth/pkce.js';

describe('OAuth PKCE S256 round-trip', () => {
  it('generates a verifier in the RFC 7636 character + length range', () => {
    for (let i = 0; i < 100; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
    }
  });

  it('derives a challenge that round-trips back via verifyS256', () => {
    const verifier = generateCodeVerifier();
    const challenge = deriveS256Challenge(verifier);
    expect(verifyS256(verifier, challenge)).toBe(true);
  });

  it('verifyS256 rejects a tampered verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = deriveS256Challenge(verifier);
    const tamperedVerifier = verifier.slice(0, -1) + (verifier.endsWith('A') ? 'B' : 'A');
    expect(verifyS256(tamperedVerifier, challenge)).toBe(false);
  });

  it('matches the canonical RFC 7636 test vector', () => {
    // RFC 7636 Appendix B: verifier "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    // → challenge "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = deriveS256Challenge(verifier);
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('rejects a verifier that is too short', () => {
    expect(() => validateVerifier('a'.repeat(42))).toThrowError(/length/);
  });

  it('rejects a verifier that is too long', () => {
    expect(() => validateVerifier('a'.repeat(129))).toThrowError(/length/);
  });

  it('rejects a verifier with invalid characters', () => {
    expect(() => validateVerifier('a'.repeat(43) + '!')).toThrowError(/unreserved/);
  });
});
