import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SESSION_MAX_AGE_MS, SESSION_TTL_MS, SESSIONS_PER_ACCOUNT } from '../server/app.js';
import { LOGIN_FAILURES } from '../server/rate-limit.js';
import { fixture, OWNER, PASSWORD, type App } from './oauth-helpers.js';

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

async function login(app: App, remoteAddress?: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
  assert.equal(res.statusCode, 200, res.body);
  const cookie = res.cookies.find((entry) => entry.name === 'cc_session')!;
  assert.equal(cookie.maxAge, SESSION_TTL_MS / 1000);
  return `cc_session=${cookie.value}`;
}

const sessionRequest = (app: App, cookie: string) =>
  app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });

const signedIn = async (app: App, cookie: string) =>
  (await sessionRequest(app, cookie)).json().operator !== null;

/** The cc_session cookie a response sets, if any (a renewal). */
async function renewal(app: App, cookie: string) {
  const res = await sessionRequest(app, cookie);
  assert.notEqual(res.json().operator, null, 'the session is valid');
  return res.cookies.find((entry) => entry.name === 'cc_session');
}

test('an idle sign-in expires after 24 hours', async (t) => {
  let now = Date.now();
  const { app, cookie: active } = await fixture(t, { clock: () => now });
  const idle = await login(app);
  assert.equal(SESSION_TTL_MS, 24 * HOUR);
  assert.equal(SESSION_MAX_AGE_MS, 30 * DAY);
  now += 23 * HOUR;
  assert.equal(await signedIn(app, active), true, 'still signed in after 23 h');
  now += HOUR;
  assert.equal(await signedIn(app, idle), false, 'the untouched sign-in is signed out at 24 h');
  assert.equal(await signedIn(app, active), true, 'the sign-in used at 23 h was renewed');
});

test('activity at 20 hours keeps a sign-in valid at 40 hours', async (t) => {
  let now = Date.now();
  const { app, cookie } = await fixture(t, { clock: () => now });
  now += 20 * HOUR;
  assert.equal(await signedIn(app, cookie), true);
  now += 20 * HOUR;
  assert.equal(await signedIn(app, cookie), true, 'renewed at 20 h, still valid at 40 h');
  now += DAY;
  assert.equal(await signedIn(app, cookie), false, 'idle for 24 h after the last use');
});

test('continuous activity cannot extend a sign-in past 30 days', async (t) => {
  const start = Date.now();
  let now = start;
  const { app, cookie } = await fixture(t, { clock: () => now });
  while (now + 12 * HOUR < start + SESSION_MAX_AGE_MS) {
    now += 12 * HOUR;
    assert.equal(await signedIn(app, cookie), true, `active at ${(now - start) / HOUR} h`);
  }
  // The last renewal (at 29.5 days) was capped: the cookie lasts only until the 30-day mark.
  now = start + SESSION_MAX_AGE_MS - 12 * HOUR;
  now += 2 * HOUR;
  assert.equal(await renewal(app, cookie), undefined, 'already at the cap: nothing to renew');
  now = start + SESSION_MAX_AGE_MS - 60_000;
  assert.equal(await signedIn(app, cookie), true, 'valid one minute before the cap');
  now = start + SESSION_MAX_AGE_MS;
  assert.equal(await signedIn(app, cookie), false, 'signed out at 30 days despite activity');
});

test('renewal is throttled to once an hour', async (t) => {
  const start = Date.now();
  let now = start;
  const { app, cookie } = await fixture(t, { clock: () => now });
  const other = await login(app);
  // Remaining lifetime above 23 h: no renewal write and no refreshed cookie.
  now += 30 * 60_000;
  assert.equal(await renewal(app, cookie), undefined, 'no renewal after 30 minutes');
  now += 29 * 60_000;
  assert.equal(await renewal(app, cookie), undefined, 'no renewal after 59 minutes');
  now = start + HOUR + 1;
  assert.ok(await renewal(app, other), 'renewed once more than an hour has passed');
  // expires_at was left unchanged by the throttled requests: the session idles out 24 h after
  // sign-in, while the one renewed after an hour lasts until 25 h.
  now = start + SESSION_TTL_MS;
  assert.equal(await signedIn(app, cookie), false, 'throttled uses did not extend it');
  assert.equal(await signedIn(app, other), true, 'the renewed session is still valid');
});

test('logout signs out only the current session', async (t) => {
  let now = Date.now();
  const { app, cookie } = await fixture(t, { clock: () => now });
  const other = await login(app);
  now += 2 * HOUR;
  assert.ok(await renewal(app, cookie), 'renewed before logout');
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { ...jsonHeaders, cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(await signedIn(app, cookie), false, 'the renewed session is gone');
  assert.equal(await signedIn(app, other), true, 'the other browser stays signed in');
});

test('an account keeps 20 sign-ins; only the oldest is signed out', async (t) => {
  let now = Date.now();
  const { app, cookie: first } = await fixture(t, { clock: () => now });
  const cookies: string[] = [];
  // Space the sign-ins out so created_at orders them, and stay under the login rate limit.
  for (let i = 0; i < SESSIONS_PER_ACCOUNT - 1; i++) {
    // Stay under the per-address login attempt budget by stepping past its window.
    now += i % 5 === 4 ? LOGIN_FAILURES.windowMs + 1 : 1000;
    cookies.push(await login(app));
  }
  assert.equal(await signedIn(app, first), true, 'the first browser survives 19 more sign-ins');
  now += LOGIN_FAILURES.windowMs + 1;
  cookies.push(await login(app));
  assert.equal(await signedIn(app, first), false, 'the 21st sign-in signs out the oldest');
  for (const cookie of cookies) assert.equal(await signedIn(app, cookie), true);
});

test('eviction breaks created_at ties by token hash', async (t) => {
  const now = Date.now();
  const { app, cookie: first } = await fixture(t, { clock: () => now });
  const hash = (cookie: string) =>
    createHash('sha256').update(cookie.slice('cc_session='.length)).digest('hex');
  // Every sign-in shares one created_at; distinct addresses stay under the login rate limits.
  let live = [first];
  for (let i = 0; i < SESSIONS_PER_ACCOUNT + 2; i++) {
    const before = [...live];
    live.push(await login(app, `198.51.${i}.10`));
    if (before.length < SESSIONS_PER_ACCOUNT) continue;
    // The existing session with the lowest token hash is the one signed out.
    const evicted = before.reduce((low, cookie) => (hash(cookie) < hash(low) ? cookie : low));
    assert.equal(await signedIn(app, evicted), false, `sign-in ${i + 2} evicts the lowest hash`);
    live = live.filter((cookie) => cookie !== evicted);
  }
  assert.equal(live.length, SESSIONS_PER_ACCOUNT);
  for (const cookie of live) assert.equal(await signedIn(app, cookie), true);
});

test('a renewal refreshes the cookie with the same token and attributes', async (t) => {
  const start = Date.now();
  let now = start;
  const { app, cookie } = await fixture(t, { clock: () => now });
  now += 5 * HOUR;
  const renewed = await renewal(app, cookie);
  assert.ok(renewed, 'renewed after 5 h');
  assert.equal(`cc_session=${renewed.value}`, cookie, 'same token');
  assert.equal(renewed.maxAge, SESSION_TTL_MS / 1000);
  assert.equal(renewed.path, '/');
  assert.equal(renewed.httpOnly, true);
  assert.equal(renewed.sameSite, 'Strict');
  assert.equal(renewed.secure, undefined, 'not secure in local development');
  // Near the 30-day cap, the cookie maxAge shrinks to the time left.
  for (now = start + DAY - HOUR; now < start + SESSION_MAX_AGE_MS - DAY; now += DAY - HOUR)
    assert.equal(await signedIn(app, cookie), true);
  now = start + SESSION_MAX_AGE_MS - 10 * HOUR;
  const capped = await renewal(app, cookie);
  assert.ok(capped, 'renewed up to the cap');
  assert.equal(capped.maxAge, (10 * HOUR) / 1000);
});
