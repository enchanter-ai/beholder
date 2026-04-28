/* enchanter/src/oauth/metadata-validator.ts — implements architecture-spec
   phase_4 failure-mode 7 (SSRF via OAuth metadata): URL parser rejects
   RFC 1918 / link-local / cloud-metadata / localhost / non-HTTPS-remote.
   Counter: a network-egress firewall is the proper defense; this is
   defense-in-depth at the application layer. */

const RFC1918_RANGES = [
  { start: ipToInt('10.0.0.0'), end: ipToInt('10.255.255.255') },
  { start: ipToInt('172.16.0.0'), end: ipToInt('172.31.255.255') },
  { start: ipToInt('192.168.0.0'), end: ipToInt('192.168.255.255') },
] as const;

const LINK_LOCAL = { start: ipToInt('169.254.0.0'), end: ipToInt('169.254.255.255') };
const LOOPBACK = { start: ipToInt('127.0.0.0'), end: ipToInt('127.255.255.255') };
const CLOUD_METADATA_IPS = new Set([
  ipToInt('169.254.169.254'), // AWS, Azure, GCP, OpenStack
  ipToInt('100.100.100.200'), // Alibaba
]);

export class SsrfRejectionError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string,
  ) {
    super(`SSRF guard rejected URL ${url}: ${reason}`);
    this.name = 'SsrfRejectionError';
  }
}

export interface SsrfGuardOptions {
  /** allow plain HTTP (use only for explicit local-development overrides) */
  allowHttp?: boolean;
  /** allow loopback (127.0.0.0/8 + localhost) */
  allowLoopback?: boolean;
  /** allow private network ranges (RFC 1918 + link-local) */
  allowPrivate?: boolean;
}

/**
 * Validate a URL against the SSRF denylist. Returns the parsed URL.
 * Throws SsrfRejectionError on any failed check.
 */
export function validateMetadataUrl(rawUrl: string, opts: SsrfGuardOptions = {}): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfRejectionError(rawUrl, 'malformed URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfRejectionError(rawUrl, `non-HTTP scheme: ${url.protocol}`);
  }
  if (url.protocol === 'http:' && !opts.allowHttp) {
    throw new SsrfRejectionError(rawUrl, 'plain HTTP not allowed for OAuth metadata');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === 'localhost.') {
    if (!opts.allowLoopback) {
      throw new SsrfRejectionError(rawUrl, 'localhost hostname blocked');
    }
  }

  // If hostname is an IPv4 literal, run range checks.
  if (isIPv4Literal(hostname)) {
    const ipInt = ipToInt(hostname);
    if (CLOUD_METADATA_IPS.has(ipInt)) {
      throw new SsrfRejectionError(rawUrl, 'cloud metadata endpoint');
    }
    if (inRange(ipInt, LOOPBACK) && !opts.allowLoopback) {
      throw new SsrfRejectionError(rawUrl, 'loopback IP range');
    }
    if (inRange(ipInt, LINK_LOCAL) && !opts.allowPrivate) {
      throw new SsrfRejectionError(rawUrl, 'link-local IP range');
    }
    for (const r of RFC1918_RANGES) {
      if (inRange(ipInt, r) && !opts.allowPrivate) {
        throw new SsrfRejectionError(rawUrl, 'RFC 1918 private IP range');
      }
    }
  }

  // IPv6 handling. URL.hostname KEEPS brackets for IPv6 ('[::1]'); strip
  // them for range checks. Lowercase for normalization.
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();

    // Loopback ::1
    if (ipv6 === '::1' && !opts.allowLoopback) {
      throw new SsrfRejectionError(rawUrl, 'IPv6 loopback ::1');
    }

    // IPv4-mapped IPv6 (::ffff:x.x.x.x). The WHATWG URL parser normalizes the
    // textual IPv4 form to hex pairs (`::ffff:a00:1` for 10.0.0.1), making
    // per-octet range checks brittle. Defensive blanket: reject ALL ::ffff:
    // prefixes unless allowPrivate is set. There's no legitimate OAuth-metadata
    // use for an IPv4-mapped IPv6 literal — public hosts use DNS names.
    if (ipv6.startsWith('::ffff:') && !opts.allowPrivate) {
      throw new SsrfRejectionError(
        rawUrl,
        'IPv4-mapped IPv6 (::ffff:) — block all without allowPrivate',
      );
    }

    // Link-local fe80::/10 — first 10 bits = 1111 1110 10 → leading "fe8", "fe9", "fea", "feb"
    if (/^fe[89ab][0-9a-f]?:/.test(ipv6) && !opts.allowPrivate) {
      throw new SsrfRejectionError(rawUrl, 'IPv6 link-local fe80::/10');
    }

    // Unique-local fc00::/7 — first 7 bits = 1111 110 → leading "fc" or "fd"
    if (/^f[cd][0-9a-f]{2}:/.test(ipv6) && !opts.allowPrivate) {
      throw new SsrfRejectionError(rawUrl, 'IPv6 unique-local fc00::/7');
    }
  }

  return url;
}

function isIPv4Literal(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map((s) => parseInt(s, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`invalid IPv4: ${ip}`);
  }
  // Deliberately use unsigned-32 arithmetic via Math.
  return parts[0]! * 0x1000000 + parts[1]! * 0x10000 + parts[2]! * 0x100 + parts[3]!;
}

function inRange(ip: number, r: { start: number; end: number }): boolean {
  return ip >= r.start && ip <= r.end;
}
