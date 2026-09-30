import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import { backupDatabase, restoreDatabase } from '../server/recovery.js';
import {
  authorizeUrl,
  consentPost,
  fixture as oauthFixture,
  fullFlow,
  mcpCall,
  openAuthorize,
  OWNER,
  PASSWORD,
  pkce,
  registerClient,
  rpcResult,
} from './oauth-helpers.js';

/**
 * Cross-owner connections (docs/AI_WORKSPACES.md and docs/REMOTE_MCP.md; acceptance
 * tests 1-10, plus the security review follow-ups). Test 11 (bounded-pool concurrency) is in
 * tests/cross-owner-pool.test.ts. Owners act through AI workspace keys, console sessions and OAuth
 * grants. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const DAY = 86_400_000;

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: {
    limits?: Partial<CityLimits>;
    now?: () => number;
    messaging?: { inboxDepth?: number };
  } = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, ...extra });
  t.after(() => app.close());
  return app;
}
function call(app: App, key: string, name: string, args: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
}
async function ok(app: App, key: string, name: string, args: unknown = {}) {
  const res = await call(app, key, name, args);
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json();
}
let addressCounter = 1;
async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.9`,
  });
  assert.equal(res.statusCode, 201, res.body);
  return { id: res.json().workspace_id as string, key: res.json().workspace_key as string };
}
/** A hosted zero-cost agent; `visibility` public gives it a public Agent Card. */
async function agent(app: App, key: string, name: string, visibility = 'private') {
  const body = await ok(app, key, 'city_create_agent', {
    template: 'template:research-analyst@1.0.0',
    overrides: { metadata: { name: name.toLowerCase().replace(/ /g, '-') }, spec: { visibility } },
    idempotency_key: randomUUID(),
  });
  return body.agent.id as string;
}
async function invite(app: App, key: string, agentId: string) {
  return (await ok(app, key, 'city_create_invite', { agent_id: agentId })).invite_token as string;
}
function request(
  app: App,
  key: string,
  from: string,
  target: { to_agent_id?: string; invite_token?: string },
  note?: string,
) {
  return call(app, key, 'city_request_connection', {
    from_agent_id: from,
    ...target,
    ...(note ? { note } : {}),
    idempotency_key: randomUUID(),
  });
}
const send = (app: App, key: string, from: string, to: string, text: string, key2 = randomUUID()) =>
  call(app, key, 'city_send_message', {
    from_agent_id: from,
    to_agent_id: to,
    text,
    idempotency_key: key2,
  });
async function events(app: App, operatorId: string) {
  const row = await app.city.db.query<{
    data: { events: Array<{ type: string; message: string }> };
  }>('SELECT data FROM workspaces WHERE operator_id=$1', [operatorId]);
  return row.rows[0]!.data.events;
}

test('§7.1 invite, approval, one-way messaging marked external, and audit in both logs', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo');
  const token = await invite(app, b.key, b1);
  assert.match(token, /^cci_[A-Za-z0-9_-]{43}$/);

  const requested = await request(
    app,
    a.key,
    a1,
    { invite_token: token },
    'Synthetic note: accept me.',
  );
  assert.equal(requested.statusCode, 200, requested.body);
  const pending = requested.json().request;
  assert.equal(pending.status, 'pending');
  assert.equal(pending.to_agent_name, null, 'A sees only its own request status');
  // The invite is single use.
  const reused = await request(app, a.key, await agent(app, a.key, 'Alpha two'), {
    invite_token: token,
  });
  assert.equal(reused.statusCode, 404, reused.body);

  const before = await send(app, a.key, a1, b1, 'Before approval');
  assert.equal(before.statusCode, 403, before.body);
  assert.equal(before.json().code, 'connection_required');

  const incoming = await ok(app, b.key, 'city_list_connection_requests', { direction: 'incoming' });
  assert.equal(incoming.incoming.length, 1);
  assert.equal(incoming.incoming[0].from_agent_name, 'Research analyst');
  assert.equal(incoming.incoming[0].from_owner_label, 'Owner A');
  assert.match(incoming.incoming[0].note, /Synthetic note/);
  const approved = await ok(app, b.key, 'city_decide_connection', {
    request_id: pending.id,
    decision: 'approve',
  });
  assert.equal(approved.request.status, 'approved');

  const sent = await send(app, a.key, a1, b1, 'Hello across owners');
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().message.origin, 'external');
  const inbox = await ok(app, b.key, 'city_read_inbox', { agent_id: b1 });
  assert.equal(inbox.messages.length, 1);
  assert.equal(inbox.messages[0].origin, 'external');
  assert.equal(inbox.messages[0].from_owner_label, 'Owner A');
  assert.equal(inbox.messages[0].parts[0].text, 'Hello across owners');
  // Direction: B cannot reply until B -> A is approved.
  const reply = await send(app, b.key, b1, a1, 'Reply before approval');
  assert.equal(reply.statusCode, 403, reply.body);
  const back = await request(app, b.key, b1, { invite_token: await invite(app, a.key, a1) });
  await ok(app, a.key, 'city_decide_connection', {
    request_id: back.json().request.id,
    decision: 'approve',
  });
  assert.equal((await send(app, b.key, b1, a1, 'Reply after approval')).statusCode, 200);

  // Audit: request, decision and invite in both owners' logs, without people's names.
  const aLog = (await events(app, a.id)).map((item) => item.type);
  const bLog = (await events(app, b.id)).map((item) => item.type);
  for (const type of ['connection.cross_requested', 'connection.cross_approved'])
    for (const log of [aLog, bLog]) assert.ok(log.includes(type), type);
  assert.ok(bLog.includes('connection.invite_created'));
});

test('§7.2 unknown, private-without-invite, disabled agents and bad invites share one 404', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const privateAgent = await agent(app, b.key, 'Hidden');
  const publicAgent = await agent(app, b.key, 'Open desk', 'public');
  const disabled = await agent(app, b.key, 'Closed desk', 'public');
  await ok(app, b.key, 'city_set_connection_requests', {
    agent_id: disabled,
    requests_enabled: false,
  });
  const bodies = [];
  for (const target of [
    { to_agent_id: randomUUID() },
    { to_agent_id: privateAgent },
    { to_agent_id: disabled },
    { invite_token: `cci_${'A'.repeat(43)}` },
  ]) {
    const res = await request(app, a.key, a1, target);
    assert.equal(res.statusCode, 404, res.body);
    bodies.push(res.body);
  }
  assert.equal(new Set(bodies).size, 1, 'identical bodies');
  // A public agent accepting requests is addressable by id; the disabled one still by invite.
  assert.equal((await request(app, a.key, a1, { to_agent_id: publicAgent })).statusCode, 200);
  const viaInvite = await request(app, a.key, a1, {
    invite_token: await invite(app, b.key, disabled),
  });
  assert.equal(viaInvite.statusCode, 200, viaInvite.body);
});

test('§7.3 denial and expiry start a 7-day cooldown; pending requests expire after 7 days', async (t) => {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const app = await fixture(t, { now: () => now });
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const first = (await request(app, a.key, a1, { to_agent_id: b1 })).json().request;
  const denied = await ok(app, b.key, 'city_decide_connection', {
    request_id: first.id,
    decision: 'deny',
  });
  assert.equal(denied.request.status, 'denied');
  const cooling = await request(app, a.key, a1, { to_agent_id: b1 });
  assert.equal(cooling.statusCode, 429, cooling.body);
  assert.equal(cooling.json().code, 'cooldown');
  assert.equal(cooling.headers['retry-after'], String(7 * 86_400));
  now += 7 * DAY + 1000;
  const second = await request(app, a.key, a1, { to_agent_id: b1 });
  assert.equal(second.statusCode, 200, second.body);
  // Unanswered for 7 days: expired, undecidable, and cooling down again.
  now += 7 * DAY + 1000;
  const listed = await ok(app, a.key, 'city_list_connection_requests', { direction: 'outgoing' });
  assert.equal(
    listed.outgoing.find((item: any) => item.id === second.json().request.id).status,
    'expired',
  );
  const late = await call(app, b.key, 'city_decide_connection', {
    request_id: second.json().request.id,
    decision: 'approve',
  });
  assert.equal(late.statusCode, 409, late.body);
  assert.equal((await request(app, a.key, a1, { to_agent_id: b1 })).statusCode, 429);
  now += 7 * DAY + 1000;
  assert.equal((await request(app, a.key, a1, { to_agent_id: b1 })).statusCode, 200);
});

test('§7.4 either owner revokes; revoked agents revoke their connections and invites', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const connect = async () => {
    const id = (await request(app, a.key, a1, { to_agent_id: b1 })).json().request.id;
    await ok(app, b.key, 'city_decide_connection', { request_id: id, decision: 'approve' });
    return id as string;
  };
  for (const revoker of [a.key, b.key]) {
    const id = await connect();
    assert.equal((await send(app, a.key, a1, b1, 'Connected')).statusCode, 200);
    const revoked = await ok(app, revoker, 'city_revoke_connection', { connection_id: id });
    assert.equal(revoked.request.status, 'revoked');
    const after = await send(app, a.key, a1, b1, 'After revocation');
    assert.equal(after.statusCode, 403, after.body);
    assert.equal(after.json().code, 'connection_required');
  }
  const id = await connect();
  const openInvite = await ok(app, b.key, 'city_create_invite', { agent_id: b1 });
  await ok(app, b.key, 'city_control', { agent_id: b1, action: 'revoke' });
  const outgoing = await ok(app, a.key, 'city_list_connection_requests', { direction: 'outgoing' });
  assert.equal(outgoing.outgoing.find((item: any) => item.id === id).status, 'revoked');
  const invites = await ok(app, b.key, 'city_list_invites');
  assert.equal(
    invites.invites.find((item: any) => item.id === openInvite.invite.id).status,
    'revoked',
  );
  assert.equal((await send(app, a.key, a1, b1, 'To a revoked agent')).statusCode, 403);
});

test('§7.5 deciding needs connections:approve, which the consent page leaves unchecked', async (t) => {
  const { app, cookie } = await oauthFixture(t);
  // The OAuth owner (a person) has an agent and hands an invite to an AI workspace.
  const created = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ name: 'Owner desk', capability: 'research', mode: 'hosted' }),
  });
  const deskId = created.json().agent.id as string;
  const issued = await app.inject({
    method: 'POST',
    url: '/api/v2/connections/invites',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ agent_id: deskId }),
  });
  assert.equal(issued.statusCode, 201, issued.body);
  const ai = await owner(app, 'Requesting AI');
  const aiAgent = await agent(app, ai.key, 'Asker');
  const pending = (
    await request(app, ai.key, aiAgent, { invite_token: issued.json().invite_token })
  ).json().request;
  // The AI sees the person's account only as an opaque label, never the account name.
  const seen = await ok(app, ai.key, 'city_list_connection_requests');
  assert.ok(!JSON.stringify(seen).includes(OWNER));
  assert.match(pending.from_owner_label, /^Requesting AI$/);

  // Consent page: connections:approve is requested but starts unchecked.
  const client = await registerClient(app);
  const form = await openAuthorize(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: pkce().challenge,
      scope: 'workspace:read connections:create connections:approve',
    }),
  );
  const login = await consentPost(app, form, { action: 'login', name: OWNER, password: PASSWORD });
  assert.match(login.body, /<input type="checkbox" name="scope" value="connections:approve">/);

  const scope = 'workspace:read connections:create connections:approve';
  const without = await fullFlow(app, { scope, scopes: ['connections:create'] });
  const denied = await mcpCall(app, without.tokens.access_token, 'tools/call', {
    name: 'city_decide_connection',
    arguments: { request_id: pending.id, decision: 'approve' },
  });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(String(denied.headers['www-authenticate']), /insufficient_scope/);
  const granted = await fullFlow(app, {
    scope,
    scopes: ['connections:create', 'connections:approve'],
  });
  const decided = await mcpCall(app, granted.tokens.access_token, 'tools/call', {
    name: 'city_decide_connection',
    arguments: { request_id: pending.id, decision: 'approve' },
  });
  assert.equal(decided.statusCode, 200, decided.body);
  assert.equal(rpcResult(decided.body).result.structuredContent.request.status, 'approved');
  // The requester cannot approve its own request, whatever its scopes.
  const self = await call(app, ai.key, 'city_decide_connection', {
    request_id: pending.id,
    decision: 'approve',
  });
  assert.equal(self.statusCode, 404, self.body);
});

test('§7.6 request and send replays are free, and concurrent duplicates make one row', async (t) => {
  const app = await fixture(t, {
    limits: { connectionRequestsPerOwnerPerDay: 2, crossSendsPerPairPerMinute: 1 },
  });
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const args = { from_agent_id: a1, to_agent_id: b1, idempotency_key: randomUUID() };
  const [one, two] = await Promise.all([
    call(app, a.key, 'city_request_connection', args),
    call(app, a.key, 'city_request_connection', args),
  ]);
  assert.equal(one.statusCode, 200, one.body);
  assert.equal(two.statusCode, 200, two.body);
  assert.equal(one.json().request.id, two.json().request.id);
  for (let index = 0; index < 3; index++)
    assert.equal(
      (await call(app, a.key, 'city_request_connection', args)).json().request.id,
      one.json().request.id,
    );
  const rows = await app.city.db.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM cross_connections WHERE from_agent_id=$1',
    [a1],
  );
  assert.equal(rows.rows[0]!.n, '1');
  // A different key for the same pair records nothing new either.
  const other = await call(app, a.key, 'city_request_connection', {
    ...args,
    idempotency_key: randomUUID(),
  });
  assert.equal(other.statusCode, 409, other.body);
  // The same key with other arguments is a conflict.
  const changed = await call(app, a.key, 'city_request_connection', { ...args, note: 'changed' });
  assert.equal(changed.statusCode, 409, changed.body);
  await ok(app, b.key, 'city_decide_connection', {
    request_id: one.json().request.id,
    decision: 'approve',
  });
  const key = randomUUID();
  const first = await send(app, a.key, a1, b1, 'Once', key);
  assert.equal(first.statusCode, 200, first.body);
  const again = await send(app, a.key, a1, b1, 'Once', key);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().message.id, first.json().message.id);
  assert.equal((await ok(app, b.key, 'city_read_inbox', { agent_id: b1 })).messages.length, 1);
});

test('§7.7 pending cap, daily cap and pair send rate answer 429 with Retry-After', async (t) => {
  const app = await fixture(t, {
    limits: {
      pendingConnectionRequestsPerTarget: 1,
      connectionRequestsPerOwnerPerDay: 2,
      crossSendsPerPairPerMinute: 1,
    },
  });
  const a = await owner(app, 'Owner A');
  const c = await owner(app, 'Owner C');
  const b = await owner(app, 'Owner B');
  const a1 = await agent(app, a.key, 'Alpha');
  const c1 = await agent(app, c.key, 'Charlie');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const b2 = await agent(app, b.key, 'Bravo two', 'public');
  const b3 = await agent(app, b.key, 'Bravo three', 'public');
  const first = await request(app, a.key, a1, { to_agent_id: b1 });
  assert.equal(first.statusCode, 200);
  const full = await request(app, c.key, c1, { to_agent_id: b1 });
  assert.equal(full.statusCode, 429, full.body);
  assert.equal(full.json().code, 'too_many_pending');
  assert.ok(full.headers['retry-after']);
  assert.equal((await request(app, a.key, a1, { to_agent_id: b2 })).statusCode, 200);
  const daily = await request(app, a.key, a1, { to_agent_id: b3 });
  assert.equal(daily.statusCode, 429, daily.body);
  assert.ok(Number(daily.headers['retry-after']) > 3600);
  await ok(app, b.key, 'city_decide_connection', {
    request_id: first.json().request.id,
    decision: 'approve',
  });
  assert.equal((await send(app, a.key, a1, b1, 'One')).statusCode, 200);
  const burst = await send(app, a.key, a1, b1, 'Two');
  assert.equal(burst.statusCode, 429, burst.body);
  assert.ok(burst.headers['retry-after']);
});

test('§7.8 a requester never reads the other owner inbox, agents, workspace or activity', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const c = await owner(app, 'Owner C');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const c1 = await agent(app, c.key, 'Charlie');
  const id = (await request(app, a.key, a1, { to_agent_id: b1 })).json().request.id;
  await ok(app, b.key, 'city_decide_connection', { request_id: id, decision: 'approve' });
  await send(app, a.key, a1, b1, 'Hello');
  assert.equal((await call(app, a.key, 'city_read_inbox', { agent_id: b1 })).statusCode, 404);
  assert.equal(
    (await call(app, a.key, 'city_ack_inbox', { agent_id: b1, seq: 1 })).statusCode,
    404,
  );
  const view = await ok(app, a.key, 'city_workspace');
  assert.deepEqual(
    view.agents.map((item: any) => item.id),
    [a1],
  );
  assert.equal(
    (await call(app, a.key, 'city_control', { agent_id: b1, action: 'pause' })).statusCode,
    404,
  );
  const lists = await ok(app, a.key, 'city_list_connection_requests');
  assert.equal(lists.incoming.length, 0);
  // A third owner cannot see, decide or revoke it.
  assert.equal(
    (await call(app, c.key, 'city_revoke_connection', { connection_id: id })).statusCode,
    404,
  );
  assert.equal(
    (await call(app, c.key, 'city_decide_connection', { request_id: id, decision: 'deny' }))
      .statusCode,
    404,
  );
  assert.equal((await send(app, c.key, c1, b1, 'Unconnected')).statusCode, 403);
  // A's activity carries no B-side details beyond the agent it connected to.
  assert.ok(!JSON.stringify(await events(app, a.id)).includes('Owner B'));
});

test('§7.10 backup and restore round-trip cross_connections between accounts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'city-cross-'));
  let restoredApp: App | undefined;
  t.after(async () => {
    await restoredApp?.close();
    await rm(root, { recursive: true, force: true });
  });
  const data = join(root, 'data');
  let app = await createApp({ dataDir: data, startWorkers: false });
  const register = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password: PASSWORD }),
    });
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const api = (cookie: string, url: string, body?: unknown) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const one = await register('Restore person one');
  const two = await register('Restore person two');
  const agentOf = async (cookie: string, name: string) =>
    (await api(cookie, '/api/agents', { name, capability: 'research', mode: 'hosted' })).json()
      .agent.id as string;
  const x = await agentOf(one, 'One desk');
  const y = await agentOf(two, 'Two desk');
  const token = (await api(two, '/api/v2/connections/invites', { agent_id: y })).json()
    .invite_token;
  const requested = await api(one, '/api/v2/connections/requests', {
    from_agent_id: x,
    invite_token: token,
    idempotency_key: randomUUID(),
  });
  assert.equal(requested.statusCode, 201, requested.body);
  const decided = await api(
    two,
    `/api/v2/connections/requests/${requested.json().request.id}/decide`,
    { decision: 'approve' },
  );
  assert.equal(decided.statusCode, 200, decided.body);
  await app.close();
  const backup = join(root, 'backup.json');
  await backupDatabase(data, backup);
  const restored = join(root, 'restored');
  await restoreDatabase(backup, restored);
  app = restoredApp = await createApp({ dataDir: restored, startWorkers: false });
  const rows = await app.city.db.query<{ status: string; from_agent_id: string }>(
    'SELECT status,from_agent_id FROM cross_connections',
  );
  assert.deepEqual(rows.rows, [{ status: 'approved', from_agent_id: x }]);
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Restore person two', password: PASSWORD }),
  });
  const cookie = `cc_session=${login.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const listed = await api(cookie, '/api/v2/connections/requests?direction=incoming');
  assert.equal(listed.json().incoming[0].status, 'approved');
});

test('hosted jobs across owners, paused requesters, reserved xw: keys and joined threads', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Owner A');
  const b = await owner(app, 'Owner B');
  const c = await owner(app, 'Owner C');
  const a1 = await agent(app, a.key, 'Alpha');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const c1 = await agent(app, c.key, 'Charlie');
  let connection = '';
  for (const [key, from] of [
    [a.key, a1],
    [c.key, c1],
  ] as const) {
    const id = (await request(app, key, from, { to_agent_id: b1 })).json().request.id;
    await ok(app, b.key, 'city_decide_connection', { request_id: id, decision: 'approve' });
    if (!connection) connection = id;
  }
  await app.city.tick();
  const job = await ok(app, a.key, 'city_create_job', {
    requesterId: a1,
    providerId: b1,
    input: 'Synthetic source text for a cross-owner brief.',
    idempotencyKey: randomUUID(),
  });
  assert.equal(job.job.costCents, 0);
  await app.city.tick();
  await app.city.tick();
  assert.equal((await ok(app, a.key, 'city_get_job', { id: job.job.id })).job.status, 'completed');
  const reserved = await call(app, a.key, 'city_create_job', {
    requesterId: a1,
    providerId: b1,
    input: 'Synthetic.',
    idempotencyKey: `xw:${randomUUID()}`,
  });
  assert.equal(reserved.statusCode, 400, reserved.body);
  // Pausing the requester stops its queued remote work and blocks new work.
  const queued = await ok(app, a.key, 'city_create_job', {
    requesterId: a1,
    providerId: b1,
    input: 'Synthetic input for a paused requester.',
    idempotencyKey: randomUUID(),
  });
  await ok(app, a.key, 'city_control', { agent_id: a1, action: 'pause' });
  await app.city.tick();
  assert.equal(
    (await ok(app, a.key, 'city_get_job', { id: queued.job.id })).job.status,
    'canceled',
  );
  assert.equal(
    (
      await call(app, a.key, 'city_create_job', {
        requesterId: a1,
        providerId: b1,
        input: 'Synthetic input while paused.',
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await ok(app, a.key, 'city_control', { agent_id: a1, action: 'resume' });
  // Revocation stops work in progress.
  const running = await ok(app, a.key, 'city_create_job', {
    requesterId: a1,
    providerId: b1,
    input: 'Synthetic input before revocation.',
    idempotencyKey: randomUUID(),
  });
  await ok(app, b.key, 'city_revoke_connection', { connection_id: connection });
  assert.equal(
    (await ok(app, a.key, 'city_get_job', { id: running.job.id })).job.status,
    'canceled',
  );

  // A caller-chosen context_id must be new or one the sender takes part in.
  const thread = randomUUID();
  assert.equal(
    (
      await call(app, c.key, 'city_send_message', {
        from_agent_id: c1,
        to_agent_id: b1,
        text: 'Private thread.',
        context_id: thread,
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    200,
  );
  const intruder = await owner(app, 'Owner D');
  const d1 = await agent(app, intruder.key, 'Delta');
  const dId = (await request(app, intruder.key, d1, { to_agent_id: b1 })).json().request.id;
  await ok(app, b.key, 'city_decide_connection', { request_id: dId, decision: 'approve' });
  const intrude = await call(app, intruder.key, 'city_send_message', {
    from_agent_id: d1,
    to_agent_id: b1,
    text: 'Joining a thread I am not part of.',
    context_id: thread,
    idempotency_key: randomUUID(),
  });
  assert.equal(intrude.statusCode, 403, intrude.body);
  assert.equal(intrude.json().code, 'context_forbidden');
});

test('bulk deny, paged lists, one pending per owner and target, and a bounded inbox share', async (t) => {
  const app = await fixture(t, { messaging: { inboxDepth: 4 } });
  const b = await owner(app, 'Owner B');
  const c = await owner(app, 'Owner C');
  const a = await owner(app, 'Owner A');
  const b1 = await agent(app, b.key, 'Bravo', 'public');
  const b2 = await agent(app, b.key, 'Bravo two', 'public');
  const b3 = await agent(app, b.key, 'Bravo three', 'public');
  const c1 = await agent(app, c.key, 'Charlie');
  const c2 = await agent(app, c.key, 'Charlie two');
  const a1 = await agent(app, a.key, 'Alpha');
  const first = (await request(app, c.key, c1, { to_agent_id: b1 })).json().request;
  // One pending request per requesting owner and target, whichever of its agents asks.
  const hog = await request(app, c.key, c2, { to_agent_id: b1 });
  assert.equal(hog.statusCode, 409, hog.body);
  assert.equal(hog.json().code, 'pending_exists');
  await request(app, c.key, c1, { to_agent_id: b2 });
  await request(app, c.key, c1, { to_agent_id: b3 });
  const fromA = (await request(app, a.key, a1, { to_agent_id: b1 })).json().request;
  const page = await ok(app, b.key, 'city_list_connection_requests', {
    direction: 'incoming',
    limit: 3,
  });
  assert.equal(page.incoming.length, 3);
  const rest = await ok(app, b.key, 'city_list_connection_requests', {
    direction: 'incoming',
    limit: 3,
    before: page.next_before,
  });
  assert.equal(rest.incoming.length, 1);
  assert.equal(rest.next_before, null);
  const bulk = await ok(app, b.key, 'city_decide_connection', {
    request_id: first.id,
    decision: 'deny',
    deny_all_pending_from_owner: true,
  });
  assert.equal(bulk.denied_count, 3);
  const after = await ok(app, b.key, 'city_list_connection_requests', { direction: 'incoming' });
  for (const item of after.incoming)
    assert.equal(item.status, item.id === fromA.id ? 'pending' : 'denied');
  await ok(app, b.key, 'city_decide_connection', { request_id: fromA.id, decision: 'approve' });
  // Another owner may hold at most a quarter of an inbox (depth 4: one message).
  assert.equal((await send(app, a.key, a1, b1, 'First')).statusCode, 200);
  const flood = await send(app, a.key, a1, b1, 'Second');
  assert.equal(flood.statusCode, 429, flood.body);
  assert.equal(flood.json().code, 'remote_quota');
  const inbox = await ok(app, b.key, 'city_read_inbox', { agent_id: b1 });
  await ok(app, b.key, 'city_ack_inbox', { agent_id: b1, seq: inbox.messages.at(-1).seq });
  assert.equal((await send(app, a.key, a1, b1, 'After acknowledgement')).statusCode, 200);
});
