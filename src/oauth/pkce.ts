/* enchanter/src/oauth/pkce.ts — implements architecture-spec
   phase_3.oauth_2_1_pkce_rfc_8707_flow (MCP MUST: clients MUST use S256 PKCE,
   per spec citation S6). RFC 7636 conformant.
   Counter: plain code_challenge_method exists in OAuth 2.0 but is forbidden
   in MCP's OAuth 2.1 profile — we do not implement it. */

import { createHash, randomBytes } from 'node:crypto';

const VERIFIER_MIN_LENGTH = 43;
const VERIFIER_MAX_LENGTH = 128;

/**
 * Generate a cryptographically-random PKCE verifier.
 * RFC 7636 §4.1: 43-128 char length, characters [A-Z][a-z][0-9]-._~.
 * We use base64url over 32 bytes → exactly 43 chars (no padding).
 */
export function generateCodeVerifier(): string {
  return base64urlEncode(randomBytes(32));
}

/**
 * Derive S256 code_challenge from verifier per RFC 7636 §4.2:
 * code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier)))
 */
export function deriveS256Challenge(verifier: string): string {
  validateVerifier(verifier);
  const hash = createHash('sha256').update(verifier, 'ascii').digest();
  return base64urlEncode(hash);
}

/**
 * Verify a verifier matches a published S256 challenge.
 * Used by the AS during code-exchange validation.
 */
export function verifyS256(verifier: string, expectedChallenge: string): boolean {
  try {
    const derived = deriveS256Challenge(verifier);
    return constantTimeStringEqual(derived, expectedChallenge);
  } catch {
    return false;
  }
}

export function validateVerifier(verifier: string): void {
  if (verifier.length < VERIFIER_MIN_LENGTH || verifier.length > VERIFIER_MAX_LENGTH) {
    throw new Error(
      `code_verifier length ${verifier.length} outside RFC 7636 range [${VERIFIER_MIN_LENGTH}, ${VERIFIER_MAX_LENGTH}]`,
    );
  }
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) {
    throw new Error('code_verifier contains characters outside RFC 7636 unreserved set');
  }
}

function base64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
