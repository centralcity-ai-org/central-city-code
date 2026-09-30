import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approve,
  authorizeUrl,
  fixture,
  fullFlow,
  mcpCall,
  openAuthorize,
  ORIGIN,
  OWNER,
  PASSWORD,
  ownerApi,
  pkce,
  RESOURCE,
  registerClient,
  tokenRequest,
  type App,
} from './oauth-helpers.js';
import { ROLLING_GRANT_DAYS, ROLLING_GRANT_MAX_DAYS } from '../shared/assistant.js';

const DAY = 86_400_000;
const START = 1_800_000_000_000;

/** Signs in at the fake clock's current time (sessions from before a clock jump have expired). */
async function signIn(app: App) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'content-type': 'application/json', 'x-city-request': '1' },
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
}

async function grants(app: App) {
  const res = await ownerApi(app, await signIn(app), '/api/assistant-access');
  assert.equal(res.statusCode, 200, res.body);
  return (
    res.json() as {
      grants: {
        id: string;
        expiresAt: string;
        renewal: string;
        endsAtLatest: string | null;
        revokedAt: string | null;
      }[];
    }
  ).grants;
}

function refresh(app: App, clientId: string, refreshToken: string) {
  return tokenRequest(app, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    resource: RESOURCE,
  });
}

test('consent offers a default-checked rolling option alongside 1, 7 and 30 days', async (t) => {
  const { app, cookie } = await fixture(t);
  const client = await registerClient(app);
  const form = await openAuthorize(
    app,
    authorizeUrl({ client_id: client.client_id, code_challenge: pkce().challenge }),
    cookie,
  );
  assert.equal(form.status, 200, form.body);
  assert.match(
    form.body,
    /value="rolling" checked> Until I disconnect \(ends after 90 days unused\)/,
  );
  for (const days of ['1', '7', '30']) assert.match(form.body, new RegExp(`value="${days}">`));
  // Exactly one expiry is preselected (the core permission boxes are checked separately).
  assert.equal((form.body.match(/name="expires_in_days" value="[^"]+" checked>/g) ?? []).length, 1);
});

test('a rolling grant is extended by each refresh and listed as until disconnected', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: 'rolling' });
  let [grant] = await grants(app);
  assert.equal(grant!.renewal, 'rolling');
  assert.equal(Date.parse(grant!.expiresAt), START + ROLLING_GRANT_DAYS * DAY);

  // 60 days later (still inside the window) a refresh moves the end to now + 90 days.
  time = START + 60 * DAY;
  const first = await refresh(app, flow.client.client_id, flow.tokens.refresh_token);
  assert.equal(first.statusCode, 200, first.body);
  [grant] = await grants(app);
  assert.equal(Date.parse(grant!.expiresAt), time + ROLLING_GRANT_DAYS * DAY);
  assert.equal(grant!.renewal, 'rolling');

  // Past the original 90-day end, the connection still works because it was used.
  time = START + 120 * DAY;
  const second = await refresh(app, flow.client.client_id, first.json().refresh_token);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal((await mcpCall(app, second.json().access_token, 'tools/list')).statusCode, 200);
  [grant] = await grants(app);
  assert.equal(Date.parse(grant!.expiresAt), START + (120 + ROLLING_GRANT_DAYS) * DAY);
});

test('a rolling grant unused for more than 90 days ends: refresh fails with invalid_grant', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: 'rolling' });
  time = START + (ROLLING_GRANT_DAYS + 1) * DAY;
  const res = await refresh(app, flow.client.client_id, flow.tokens.refresh_token);
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'invalid_grant');
  const [grant] = await grants(app);
  assert.ok(Date.parse(grant!.expiresAt) <= time);
});

test('a consent posted without a duration choice becomes a fixed 1-day grant', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: null });
  const [grant] = await grants(app);
  assert.equal(grant!.renewal, 'fixed');
  assert.equal(grant!.endsAtLatest, null);
  assert.equal(Date.parse(grant!.expiresAt), START + DAY);
  time = START + DAY;
  const ended = await refresh(app, flow.client.client_id, flow.tokens.refresh_token);
  assert.equal(ended.json().error, 'invalid_grant');
});

test('an unknown duration choice also falls back to 1 day', async (t) => {
  const { app } = await fixture(t, { clock: () => START });
  await fullFlow(app, { days: '365' });
  const [grant] = await grants(app);
  assert.equal(grant!.renewal, 'fixed');
  assert.equal(Date.parse(grant!.expiresAt), START + DAY);
});

test('a rolling grant is capped one year after creation; later refreshes fail', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: 'rolling' });
  const ceiling = START + ROLLING_GRANT_MAX_DAYS * DAY;
  let [grant] = await grants(app);
  assert.equal(Date.parse(grant!.endsAtLatest!), ceiling);

  // Used every 80 days, then near day 360: the end moves to the ceiling, not day 450.
  let token = flow.tokens.refresh_token;
  for (const day of [80, 160, 240, 320, 360]) {
    time = START + day * DAY;
    const res = await refresh(app, flow.client.client_id, token);
    assert.equal(res.statusCode, 200, res.body);
    token = res.json().refresh_token;
  }
  [grant] = await grants(app);
  assert.equal(Date.parse(grant!.expiresAt), ceiling);
  assert.equal(grant!.renewal, 'rolling');
  assert.equal(Date.parse(grant!.endsAtLatest!), ceiling);

  // Still usable just before the ceiling, without moving it.
  time = ceiling - DAY;
  const last = await refresh(app, flow.client.client_id, token);
  assert.equal(last.statusCode, 200, last.body);
  assert.ok(last.json().expires_in * 1000 <= DAY);
  [grant] = await grants(app);
  assert.equal(Date.parse(grant!.expiresAt), ceiling);

  // After day 365 the grant has ended like an expired one: the owner reconnects.
  time = ceiling + 1;
  const ended = await refresh(app, flow.client.client_id, last.json().refresh_token);
  assert.equal(ended.statusCode, 400);
  assert.equal(ended.json().error, 'invalid_grant');
  assert.equal((await mcpCall(app, last.json().access_token, 'tools/list')).statusCode, 401);
});

test('a fixed 7-day grant still ends at 7 days despite refreshes', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: '7' });
  let token = flow.tokens.refresh_token;
  for (const day of [2, 4, 6]) {
    time = START + day * DAY;
    const res = await refresh(app, flow.client.client_id, token);
    assert.equal(res.statusCode, 200, res.body);
    token = res.json().refresh_token;
  }
  const [grant] = await grants(app);
  assert.equal(grant!.renewal, 'fixed');
  assert.equal(grant!.endsAtLatest, null);
  assert.equal(Date.parse(grant!.expiresAt), START + 7 * DAY);
  time = START + 7 * DAY;
  const ended = await refresh(app, flow.client.client_id, token);
  assert.equal(ended.json().error, 'invalid_grant');
});

test('revoking a rolling grant under AI connections is immediate', async (t) => {
  let time = START;
  const { app } = await fixture(t, { clock: () => time });
  const flow = await fullFlow(app, { days: 'rolling' });
  time += 10 * DAY;
  const renewed = await refresh(app, flow.client.client_id, flow.tokens.refresh_token);
  assert.equal(renewed.statusCode, 200, renewed.body);
  const next = renewed.json();
  const [grant] = await grants(app);
  const revoked = await ownerApi(
    app,
    await signIn(app),
    `/api/assistant-access/${grant!.id}`,
    undefined,
    'DELETE',
  );
  assert.equal(revoked.statusCode, 200, revoked.body);
  assert.equal((await mcpCall(app, next.access_token, 'tools/list')).statusCode, 401);
  const after = await refresh(app, flow.client.client_id, next.refresh_token);
  assert.equal(after.json().error, 'invalid_grant');
  const [listed] = await grants(app);
  assert.notEqual(listed!.revokedAt, null);
});

test('the first MCP 401 names a minimal default scope set', async (t) => {
  const { app } = await fixture(t);
  const res = await mcpCall(app, undefined, 'tools/list');
  assert.equal(res.statusCode, 401);
  assert.equal(
    res.headers['www-authenticate'],
    `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="workspace:read agents:create rooms:join rooms:host messages:read messages:send"`,
  );
  // The client can request exactly that set.
  const client = await registerClient(app);
  const back = await approve(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: pkce().challenge,
      scope: 'workspace:read agents:create rooms:join rooms:host messages:read messages:send',
    }),
    { scopes: ['agents:create', 'rooms:join', 'messages:read', 'messages:send'] },
  );
  assert.ok(back.searchParams.get('code'));
});
