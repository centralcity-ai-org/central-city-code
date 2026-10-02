import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GoogleTokenError,
  createJwksCache,
  eligibleGoogleAccount,
  verifyGoogleIdToken,
} from '../server/google/verify.js';
import { googleClient, googleSignInEnabled } from '../server/google/config.js';
import {
  PEOPLE_BIRTHDAYS_URL,
  ageCheckFromBirthdays,
  ageInYears,
  checkGoogleAge,
} from '../server/google/age.js';
import { FAKE_CLIENT_ID, claimsFor, fakeGoogle, fakeKey, signIdToken } from './fake-google.js';

/**
 * Google ID token verification (server/google/verify.ts, docs/GOOGLE_SIGNIN.md) against a local
 * fake JWKS and signer: no network, synthetic values only.
 */
const NONCE = 'test-nonce-000000000000000000000000000000001';
const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);

function setup() {
  const google = fakeGoogle();
  const clock = { now: NOW };
  const jwks = createJwksCache(google.transport, () => clock.now);
  const key = google.keys[0]!;
  const verify = (token: string, nonce = NONCE, now = clock.now) =>
    verifyGoogleIdToken(token, { clientId: FAKE_CLIENT_ID, nonce, now }, jwks);
  const token = (extra: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
    signIdToken(key, claimsFor(NONCE, clock.now, extra), header);
  return { google, clock, jwks, key, verify, token };
}
async function refused(promise: Promise<unknown>, code: GoogleTokenError['code']) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof GoogleTokenError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

// The gmail.com rule itself needs gmail.com addresses (release waiver: synthetic test fixture).
const GMAIL = 'synthetic.person@gmail.com';

test('a valid gmail.com token yields only sub, email and hd', async () => {
  const { verify, token } = setup();
  assert.deepEqual(await verify(token({ email: GMAIL, hd: undefined })), {
    sub: '100000000000000000001',
    email: GMAIL,
    hd: null,
  });
  // The issuer may come without the scheme.
  assert.equal((await verify(token({ iss: 'accounts.google.com' }))).sub, '100000000000000000001');
});

test('a Google Workspace account (hd present) is eligible; other domains are not', async () => {
  const { verify, token } = setup();
  const workspace = await verify(token({ email: 'person@example.org', hd: 'Example.org' }));
  assert.deepEqual(workspace, {
    sub: '100000000000000000001',
    email: 'person@example.org',
    hd: 'example.org',
  });
  await refused(verify(token({ email: 'person@example.org', hd: undefined })), 'ineligible_domain');
  await refused(
    verify(token({ email: 'person@googlemail.com.example', hd: undefined })),
    'ineligible_domain',
  );
  assert.equal(eligibleGoogleAccount('Person@GMAIL.com', null), true);
  assert.equal(eligibleGoogleAccount('person@gmail.com.example.org', null), false);
});

test('a bad signature is refused, also with a known key id', async () => {
  const { verify, token } = setup();
  const other = fakeKey('test-kid-1');
  await refused(verify(signIdToken(other, claimsFor(NONCE, NOW))), 'bad_signature');
  // A tampered payload under the original signature.
  const [head, , signature] = token().split('.');
  const forged = Buffer.from(
    JSON.stringify(claimsFor(NONCE, NOW, { sub: 'someone-else' })),
  ).toString('base64url');
  await refused(verify(`${head}.${forged}.${signature}`), 'bad_signature');
});

test('only RS256 is accepted (no "none", no HMAC)', async () => {
  const { verify, token, key } = setup();
  await refused(verify(token({}, { alg: 'none' })), 'bad_algorithm');
  await refused(verify(token({}, { alg: 'HS256' })), 'bad_algorithm');
  const head = Buffer.from(JSON.stringify({ alg: 'none', kid: key.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claimsFor(NONCE, NOW))).toString('base64url');
  await refused(verify(`${head}.${body}.`), 'malformed');
  await refused(verify('not-a-token'), 'malformed');
});

test('wrong issuer or audience is refused', async () => {
  const { verify, token } = setup();
  await refused(verify(token({ iss: 'https://accounts.example.com' })), 'bad_issuer');
  await refused(verify(token({ iss: 'http://accounts.google.com' })), 'bad_issuer');
  await refused(
    verify(token({ aud: 'another-client.apps.googleusercontent.com' })),
    'bad_audience',
  );
  await refused(
    verify(token({ azp: 'another-client.apps.googleusercontent.com' })),
    'bad_audience',
  );
  await refused(
    verify(token({ aud: [FAKE_CLIENT_ID, 'another'], azp: 'another' })),
    'bad_audience',
  );
});

test('expired tokens and tokens issued in the future are refused (60 s skew)', async () => {
  const { verify, token } = setup();
  const iat = Math.floor(NOW / 1000);
  await refused(verify(token({ iat: iat - 7200, exp: iat - 61 })), 'expired');
  assert.ok(await verify(token({ iat: iat - 7200, exp: iat - 30 })), 'within the skew');
  await refused(verify(token({ iat: iat + 120 })), 'issued_in_future');
  await refused(verify(token({ exp: undefined })), 'expired');
});

test('the nonce must be the one stored for the flow', async () => {
  const { verify, token } = setup();
  await refused(verify(token(), 'test-nonce-000000000000000000000000000000002'), 'bad_nonce');
  await refused(verify(token({ nonce: undefined })), 'bad_nonce');
});

test('an unverified email is refused', async () => {
  const { verify, token } = setup();
  await refused(verify(token({ email_verified: false })), 'email_unverified');
  await refused(verify(token({ email_verified: 'true' })), 'email_unverified');
  await refused(verify(token({ email_verified: undefined })), 'email_unverified');
});

test('the JWKS is cached for its max-age and refetched on rotation (an unknown kid)', async () => {
  const { google, clock, verify, token, key } = setup();
  await verify(token());
  await verify(token());
  assert.equal(google.jwksFetches(), 1, 'cached');
  // Google rotates: a new key id appears. Within the refetch interval it is not fetched again.
  const rotated = fakeKey('test-kid-2');
  google.keys.push(rotated);
  const fresh = signIdToken(rotated, claimsFor(NONCE, clock.now));
  await refused(verify(fresh), 'unknown_key');
  assert.equal(google.jwksFetches(), 1);
  clock.now += 61_000;
  assert.equal((await verify(fresh, NONCE, clock.now)).sub, '100000000000000000001');
  assert.equal(google.jwksFetches(), 2, 'refetched once for the unknown kid');
  // After max-age the keys are read again.
  clock.now += 3_600_000;
  await verify(signIdToken(rotated, claimsFor(NONCE, clock.now)), NONCE, clock.now);
  assert.equal(google.jwksFetches(), 3);
  // A removed key stops verifying once the JWKS is refreshed.
  google.keys.splice(0, 1);
  clock.now += 3_600_001;
  await refused(
    verify(signIdToken(key, claimsFor(NONCE, clock.now)), NONCE, clock.now),
    'unknown_key',
  );
});

test('an unreachable JWKS fails closed', async () => {
  const jwks = createJwksCache(
    async () => ({ status: 503, headers: {}, body: '' }),
    () => NOW,
  );
  await refused(
    verifyGoogleIdToken(
      signIdToken(fakeKey('test-kid-1'), claimsFor(NONCE, NOW)),
      { clientId: FAKE_CLIENT_ID, nonce: NONCE, now: NOW },
      jwks,
    ),
    'jwks_unavailable',
  );
});

test('configuration: the flag and both client values, from the environment only by name', () => {
  assert.equal(googleSignInEnabled({ env: {} }), false);
  assert.equal(googleSignInEnabled({ env: { CITY_GOOGLE_SIGNIN: '1' } }), true);
  assert.equal(googleClient({ env: { CITY_GOOGLE_SIGNIN: '1' } }), null);
  assert.equal(
    googleClient({
      env: {
        CITY_GOOGLE_SIGNIN: '0',
        GOOGLE_OAUTH_CLIENT_ID: 'a',
        GOOGLE_OAUTH_CLIENT_SECRET: 'b',
      },
    }),
    null,
  );
  assert.deepEqual(
    googleClient({
      env: {
        CITY_GOOGLE_SIGNIN: '1',
        GOOGLE_OAUTH_CLIENT_ID: 'a',
        GOOGLE_OAUTH_CLIENT_SECRET: 'b',
      },
    }),
    { clientId: 'a', clientSecret: 'b' },
  );
});

test('age in UTC: the 18th birthday counts from its first moment; 29 February from 1 March', () => {
  const at = (iso: string) => Date.parse(iso);
  const birth = { year: 2008, month: 10, day: 1 };
  assert.equal(ageInYears(birth, at('2026-09-30T23:59:59Z')), 17);
  assert.equal(ageInYears(birth, at('2026-10-01T00:00:00Z')), 18);
  const leap = { year: 2008, month: 2, day: 29 };
  assert.equal(ageInYears(leap, at('2026-02-28T12:00:00Z')), 17);
  assert.equal(ageInYears(leap, at('2026-03-01T00:00:00Z')), 18);
  assert.equal(
    ageCheckFromBirthdays({ birthdays: [{ date: birth }] }, at('2026-10-01T00:00:00Z')),
    'over_18',
  );
  assert.equal(
    ageCheckFromBirthdays({ birthdays: [{ date: birth }] }, at('2026-09-30T23:59:59Z')),
    'under_18',
  );
  for (const body of [
    null,
    {},
    { birthdays: [{ date: { month: 10, day: 1 } }] },
    { birthdays: [{ date: { year: 2008, day: 1 } }] },
    { birthdays: [{ date: { year: 2008, month: 13, day: 1 } }] },
    { birthdays: [{ date: { year: 2030, month: 1, day: 1 } }] },
    { birthdays: [{ text: '1 October 2008' }] },
  ])
    assert.equal(ageCheckFromBirthdays(body, at('2026-10-01T00:00:00Z')), 'unknown');
});

test('the People API is read once with the token, and any failure is unknown', async () => {
  const seen: string[] = [];
  const answer =
    (status: number, body: string) =>
    async (request: { url: string; headers: Record<string, string> }) => {
      seen.push(`${request.url} ${request.headers.authorization}`);
      return { status, headers: {}, body };
    };
  const now = Date.parse('2026-10-01T00:00:00Z');
  const adult = JSON.stringify({ birthdays: [{ date: { year: 1990, month: 1, day: 1 } }] });
  assert.equal(await checkGoogleAge(answer(200, adult), 'test-access-0001', now), 'over_18');
  assert.deepEqual(seen, [`${PEOPLE_BIRTHDAYS_URL} Bearer test-access-0001`]);
  assert.equal(await checkGoogleAge(answer(403, '{}'), 'test-access-0001', now), 'unknown');
  assert.equal(await checkGoogleAge(answer(200, 'not json'), 'test-access-0001', now), 'unknown');
  assert.equal(await checkGoogleAge(answer(200, adult), undefined, now), 'unknown');
  assert.equal(
    await checkGoogleAge(async () => Promise.reject(new Error('offline')), 'test-access-0001', now),
    'unknown',
  );
});

test('the ACCOUNT birthday is preferred over profile or contact birthdays', () => {
  const now = Date.parse('2026-10-01T00:00:00Z');
  const entry = (type: string, year: number) => ({
    metadata: { source: { type } },
    date: { year, month: 1, day: 1 },
  });
  // A profile date says adult, the account date says 15: the account date decides.
  assert.equal(
    ageCheckFromBirthdays({ birthdays: [entry('PROFILE', 1980), entry('ACCOUNT', 2011)] }, now),
    'under_18',
  );
  assert.equal(
    ageCheckFromBirthdays({ birthdays: [entry('CONTACT', 2011), entry('ACCOUNT', 1980)] }, now),
    'over_18',
  );
  // Without an ACCOUNT entry, the others count (and must agree).
  assert.equal(ageCheckFromBirthdays({ birthdays: [entry('PROFILE', 1980)] }, now), 'over_18');
  // An ACCOUNT entry without a full date is unknown, even next to a full profile date.
  assert.equal(
    ageCheckFromBirthdays(
      {
        birthdays: [
          entry('PROFILE', 1980),
          { metadata: { source: { type: 'ACCOUNT' } }, date: { month: 1, day: 1 } },
        ],
      },
      now,
    ),
    'unknown',
  );
});

test('an unreachable JWKS after expiry is fetched at most once a minute (fail closed)', async () => {
  let fetches = 0;
  let up = true;
  const google = fakeGoogle();
  const clock = { now: NOW };
  const jwks = createJwksCache(
    async (request) => {
      fetches += 1;
      return up ? google.transport(request) : { status: 503, headers: {}, body: '' };
    },
    () => clock.now,
  );
  const verify = () =>
    verifyGoogleIdToken(
      signIdToken(google.keys[0]!, claimsFor(NONCE, clock.now)),
      { clientId: FAKE_CLIENT_ID, nonce: NONCE, now: clock.now },
      jwks,
    );
  await verify();
  assert.equal(fetches, 1);
  up = false;
  clock.now += 3_600_001;
  await refused(verify(), 'jwks_unavailable');
  await refused(verify(), 'jwks_unavailable');
  await refused(verify(), 'jwks_unavailable');
  assert.equal(fetches, 2, 'no refetch per callback during the outage');
  up = true;
  clock.now += 61_000;
  assert.ok(await verify());
  assert.equal(fetches, 3);
});
