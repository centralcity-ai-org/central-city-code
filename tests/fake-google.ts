import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type {
  GoogleHttpRequest,
  GoogleHttpResponse,
  GoogleTransport,
} from '../server/google/config.js';
import { GOOGLE_ENDPOINTS } from '../server/google/config.js';
import { PEOPLE_BIRTHDAYS_URL } from '../server/google/age.js';

/**
 * A local stand-in for Google's token and JWKS endpoints (no network). It signs ID tokens with
 * its own RSA keys, serves them as a JWKS, and exchanges authorization codes it issued for those
 * tokens. Synthetic values only.
 */
export const FAKE_CLIENT_ID = 'test-client-0001.apps.googleusercontent.com';
export const FAKE_CLIENT_SECRET = 'test-secret-0001';

export interface FakeKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
}

export function fakeKey(kid: string): FakeKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; n: string; e: string };
  return { kid, privateKey, publicJwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}

export function signIdToken(
  key: { kid: string; privateKey: KeyObject },
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): string {
  const head = Buffer.from(
    JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString(
    'base64url',
  );
  return `${head}.${body}.${signature}`;
}

/** Claims of a valid ID token for `nonce` at `nowMs` (overridable per test). */
export function claimsFor(
  nonce: string,
  nowMs: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const iat = Math.floor(nowMs / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: FAKE_CLIENT_ID,
    azp: FAKE_CLIENT_ID,
    sub: '100000000000000000001',
    // A Google Workspace account on a reserved domain (hd makes it eligible, verify.ts); tests of
    // the gmail.com rule itself pass their own address.
    email: 'synthetic.person@example.com',
    hd: 'example.com',
    email_verified: true,
    nonce,
    iat,
    exp: iat + 3600,
    ...extra,
  };
}

/** The People API answer for one access token (default: an adult's full birthday). */
export interface FakePeople {
  status?: number;
  body?: unknown;
}
export const ADULT_BIRTHDAY = { birthdays: [{ date: { year: 1990, month: 5, day: 17 } }] };

export interface FakeGoogle {
  transport: GoogleTransport;
  keys: FakeKey[];
  requests: GoogleHttpRequest[];
  /**
   * Issues a code that the token endpoint exchanges for `idToken`, only with the PKCE verifier
   * whose S256 hash is `challenge` (from the authorization URL).
   */
  issueCode(idToken: string, challenge: string, people?: FakePeople): string;
  /** Number of JWKS fetches so far. */
  jwksFetches(): number;
  /** Cache-Control max-age (seconds) sent with the JWKS. */
  maxAge: number;
}

export function fakeGoogle(keys: FakeKey[] = [fakeKey('test-kid-1')]): FakeGoogle {
  const codes = new Map<string, { idToken: string; challenge: string; people: FakePeople }>();
  const tokens = new Map<string, FakePeople>();
  const requests: GoogleHttpRequest[] = [];
  let fetches = 0;
  const google: FakeGoogle = {
    keys,
    requests,
    maxAge: 3600,
    issueCode(idToken, challenge, people = { body: ADULT_BIRTHDAY }) {
      const code = `test-code-${randomBytes(8).toString('hex')}`;
      codes.set(code, { idToken, challenge, people });
      return code;
    },
    jwksFetches: () => fetches,
    transport: async (request): Promise<GoogleHttpResponse> => {
      requests.push(request);
      if (request.method === 'GET' && request.url === GOOGLE_ENDPOINTS.jwks) {
        fetches += 1;
        return {
          status: 200,
          headers: { 'cache-control': `public, max-age=${google.maxAge}` },
          body: JSON.stringify({ keys: google.keys.map((key) => key.publicJwk) }),
        };
      }
      if (request.method === 'POST' && request.url === GOOGLE_ENDPOINTS.token) {
        const form = new URLSearchParams(request.body ?? '');
        const issued = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (
          !issued ||
          createHash('sha256').update(verifier).digest('base64url') !== issued.challenge ||
          form.get('grant_type') !== 'authorization_code' ||
          form.get('client_id') !== FAKE_CLIENT_ID ||
          form.get('client_secret') !== FAKE_CLIENT_SECRET ||
          !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)
        )
          return { status: 400, headers: {}, body: JSON.stringify({ error: 'invalid_grant' }) };
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            id_token: issued.idToken,
            access_token: (() => {
              const token = `test-access-${randomBytes(8).toString('hex')}`;
              tokens.set(token, issued.people);
              return token;
            })(),
          }),
        };
      }
      if (request.method === 'GET' && request.url === PEOPLE_BIRTHDAYS_URL) {
        const people = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!people) return { status: 401, headers: {}, body: '{}' };
        return {
          status: people.status ?? 200,
          headers: {},
          body: JSON.stringify(people.body ?? {}),
        };
      }
      return { status: 404, headers: {}, body: '{}' };
    },
  };
  return google;
}
