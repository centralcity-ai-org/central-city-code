import { createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';
import { GOOGLE_ENDPOINTS, GOOGLE_ISSUERS, GOOGLE_LIMITS, type GoogleTransport } from './config.js';

/**
 * Google ID token verification (OpenID Connect Core §3.1.3.7), server-side only:
 * - RS256 only, signed by a key from Google's JWKS (cached, refreshed on expiry and, at most once
 *   a minute, for an unknown key id, so key rotation is picked up);
 * - `iss` is accounts.google.com (with or without https://), `aud` is our client id (and `azp`,
 *   when present, too), `exp` and `iat` hold within a small skew;
 * - `nonce` equals the one this server stored for the flow;
 * - `email_verified` is true, and the account is eligible: a gmail.com address or a Google
 *   Workspace account (`hd` present).
 * Only `sub`, `email` and `hd` leave this function.
 */

export type GoogleTokenErrorCode =
  | 'malformed'
  | 'bad_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'bad_issuer'
  | 'bad_audience'
  | 'expired'
  | 'issued_in_future'
  | 'bad_nonce'
  | 'email_unverified'
  | 'ineligible_domain'
  | 'jwks_unavailable';

export class GoogleTokenError extends Error {
  constructor(public code: GoogleTokenErrorCode) {
    super(`Google ID token refused: ${code}`);
  }
}

export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  hd: string | null;
}

interface Jwk {
  kty?: unknown;
  kid?: unknown;
  alg?: unknown;
  use?: unknown;
  n?: unknown;
  e?: unknown;
}

export interface JwksCache {
  key(kid: string): Promise<KeyObject>;
}

/** Google's signing keys, cached per Cache-Control max-age (clamped), refetched on rotation. */
export function createJwksCache(transport: GoogleTransport, clock: () => number): JwksCache {
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let fetchedAt = -Infinity;
  let pending: Promise<void> | null = null;
  async function refresh() {
    const response = await transport({
      method: 'GET',
      url: GOOGLE_ENDPOINTS.jwks,
      headers: { accept: 'application/json' },
    }).catch(() => null);
    fetchedAt = clock();
    if (!response || response.status !== 200) throw new GoogleTokenError('jwks_unavailable');
    let parsed: { keys?: unknown };
    try {
      parsed = JSON.parse(response.body) as { keys?: unknown };
    } catch {
      throw new GoogleTokenError('jwks_unavailable');
    }
    const next = new Map<string, KeyObject>();
    for (const jwk of Array.isArray(parsed.keys) ? (parsed.keys as Jwk[]) : []) {
      if (
        jwk.kty !== 'RSA' ||
        typeof jwk.kid !== 'string' ||
        (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
        (jwk.use !== undefined && jwk.use !== 'sig') ||
        typeof jwk.n !== 'string' ||
        typeof jwk.e !== 'string'
      )
        continue;
      try {
        next.set(
          jwk.kid,
          createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' }),
        );
      } catch {
        // A malformed key is skipped; the others stay usable.
      }
    }
    if (!next.size) throw new GoogleTokenError('jwks_unavailable');
    const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(response.headers['cache-control'] ?? '');
    const ttl = maxAge ? Number(maxAge[1]) * 1000 : GOOGLE_LIMITS.jwksDefaultTtlMs;
    keys = next;
    expiresAt =
      fetchedAt + Math.min(GOOGLE_LIMITS.jwksMaxTtlMs, Math.max(GOOGLE_LIMITS.jwksMinTtlMs, ttl));
  }
  async function load() {
    pending ??= refresh().finally(() => {
      pending = null;
    });
    await pending;
  }
  return {
    async key(kid) {
      const now = clock();
      // At most one fetch per jwksRefetchMs, also while the cache is expired and Google is
      // unreachable; expired keys are never used (fail closed).
      const due = now - fetchedAt >= GOOGLE_LIMITS.jwksRefetchMs;
      if (due && (now >= expiresAt || !keys.has(kid))) await load();
      if (clock() >= expiresAt) throw new GoogleTokenError('jwks_unavailable');
      return keys.get(kid) ?? Promise.reject(new GoogleTokenError('unknown_key'));
    },
  };
}

function decodeJson(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new GoogleTokenError('malformed');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw new GoogleTokenError('malformed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new GoogleTokenError('malformed');
  return value as Record<string, unknown>;
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** gmail.com addresses, or any Google Workspace account (the `hd` claim is present). */
export function eligibleGoogleAccount(email: string, hd: string | null): boolean {
  return Boolean(hd) || email.toLowerCase().endsWith('@gmail.com');
}

export async function verifyGoogleIdToken(
  token: string,
  expected: { clientId: string; nonce: string; now: number },
  jwks: JwksCache,
): Promise<VerifiedGoogleIdentity> {
  if (typeof token !== 'string' || token.length > 8192) throw new GoogleTokenError('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[2] || !/^[A-Za-z0-9_-]+$/.test(parts[2]))
    throw new GoogleTokenError('malformed');
  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  if (header.alg !== 'RS256') throw new GoogleTokenError('bad_algorithm');
  if (typeof header.kid !== 'string' || !header.kid) throw new GoogleTokenError('unknown_key');
  const key = await jwks.key(header.kid);
  const signed = verify(
    'RSA-SHA256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    key,
    Buffer.from(parts[2], 'base64url'),
  );
  if (!signed) throw new GoogleTokenError('bad_signature');

  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss))
    throw new GoogleTokenError('bad_issuer');
  const audience = claims.aud;
  const audienceOk = Array.isArray(audience)
    ? audience.includes(expected.clientId) && claims.azp === expected.clientId
    : audience === expected.clientId;
  if (!audienceOk || (claims.azp !== undefined && claims.azp !== expected.clientId))
    throw new GoogleTokenError('bad_audience');
  const skew = GOOGLE_LIMITS.skewMs;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 + skew <= expected.now)
    throw new GoogleTokenError('expired');
  if (typeof claims.iat !== 'number' || claims.iat * 1000 - skew > expected.now)
    throw new GoogleTokenError('issued_in_future');
  if (typeof claims.nonce !== 'string' || !sameString(claims.nonce, expected.nonce))
    throw new GoogleTokenError('bad_nonce');
  if (claims.email_verified !== true) throw new GoogleTokenError('email_unverified');
  const sub = claims.sub;
  const email = claims.email;
  if (typeof sub !== 'string' || !/^[\x21-\x7e]{1,255}$/.test(sub))
    throw new GoogleTokenError('malformed');
  if (typeof email !== 'string' || email.length < 3 || email.length > 320 || !email.includes('@'))
    throw new GoogleTokenError('malformed');
  const hd =
    claims.hd === undefined
      ? null
      : typeof claims.hd === 'string' && /^[a-z0-9.-]{1,253}$/i.test(claims.hd)
        ? claims.hd.toLowerCase()
        : (() => {
            throw new GoogleTokenError('malformed');
          })();
  if (!eligibleGoogleAccount(email, hd)) throw new GoogleTokenError('ineligible_domain');
  return { sub, email, hd };
}
