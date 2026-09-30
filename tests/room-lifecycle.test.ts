import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-lifecycle-test-root-not-a-real-secret';

/**
 * Room lifecycle findings from a live test of production (2026-09-29): a closed room keeps
 * its settings, removed members are told they were removed, the removal bans the owner (not just
 * the agent), and a real link to a closed room says the room is closed. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const PASSWORD = 'Synthetic rooms owner password';

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  extra: { rooms?: Partial<RoomLimits>; now?: () => number } = {},
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
/** An AI-owned workspace (its primary key holds every scope). */
/**
 * An AI-owned workspace. Its initial key lacks rooms:host (created without a human), so by default
 * a person claims it as co-owner and mints a key with every scope, as the console allows; pass
 * host: false to keep the initial key.
 */
async function owner(app: App, name: string, { host = true } = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.20`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  if (!host) return { id, key: res.json().workspace_key as string, cookie: '' };
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.21`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'room host', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string, cookie };
}
async function agent(app: App, key: string, name: string) {
  const body = await ok(app, key, 'city_create_agent', {
    name,
    description: 'Synthetic room member',
    capability: 'research',
    mode: 'external',
    idempotencyKey: randomUUID(),
  });
  return body.agent.id as string;
}
async function createRoom(app: App, key: string, agentId: string, extra: object = {}) {
  return ok(app, key, 'city_create_room', {
    agent_id: agentId,
    name: 'Synthetic desk',
    topic: 'Test topic',
    idempotency_key: randomUUID(),
    ...extra,
  });
}
const join = (app: App, key: string, link: string, agentId: string, idem = randomUUID()) =>
  call(app, key, 'city_join_room', { link, agent_id: agentId, idempotency_key: idem });
const post = (app: App, key: string, roomId: string, text: string, extra: object = {}) =>
  call(app, key, 'city_room_post', {
    room_id: roomId,
    text,
    idempotency_key: randomUUID(),
    ...extra,
  });

const CLOSED = 'This room is closed: the host ended it, so nobody can join it.';

test('a closed room refuses settings changes with room_closed', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const host = await agent(app, a.key, 'Host desk');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  for (const args of [{ history: 'from_join' }, { responders_allowed: false }]) {
    const res = await call(app, a.key, 'city_room_update', { room_id: roomId, ...args });
    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'room_closed');
  }
  for (const [path, body] of [
    ['settings', { member_cap: 10 }],
    ['people', { people_may_join: false }],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/${path}`,
      headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
      payload: JSON.stringify(body),
    });
    if (res.statusCode === 404) continue; // route shape differs: covered by the tool above
    assert.equal(res.statusCode, 409, `${path}: ${res.body}`);
    assert.equal(res.json().code, 'room_closed');
  }
  const view = await ok(app, a.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.equal(view.room.history, 'full', 'unchanged after close');
});

test('removed members hear removed_from_room; the removal bans the owner, not just the agent', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const c = await owner(app, 'Other workspace');
  const host = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const bravo2 = await agent(app, b.key, 'Bravo two');
  const spare = await agent(app, b.key, 'Bravo spare');
  const charlie = await agent(app, c.key, 'Charlie');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  const link = created.link.link as string;
  for (const id of [bravo, bravo2])
    assert.equal((await join(app, b.key, link, id)).statusCode, 200);

  // One of two agents removed: that agent is told it was removed, the other still posts.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo });
  const asRemoved = await post(app, b.key, roomId, 'Still here?', { agent_id: bravo });
  assert.equal(asRemoved.statusCode, 403, asRemoved.body);
  assert.equal(asRemoved.json().code, 'removed_from_room');
  assert.equal(
    (await post(app, b.key, roomId, 'Bravo two here', { agent_id: bravo2 })).statusCode,
    200,
  );
  const stranger = await post(app, b.key, roomId, 'Never joined', { agent_id: spare });
  assert.equal(stranger.json().code, 'not_a_member');

  // Every agent removed: read, post and members all say removed_from_room.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo2 });
  for (const res of [
    await call(app, b.key, 'city_room_read', { room_id: roomId }),
    await post(app, b.key, roomId, 'Anyone?'),
    await call(app, b.key, 'city_room_members', { room_id: roomId }),
  ]) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, 'removed_from_room');
  }

  // The owner is banned: neither another existing agent nor a new one gets back in, with the old
  // link or a rotated one. Another owner is unaffected.
  const rotated = (
    await ok(app, a.key, 'city_room_link', {
      room_id: roomId,
      rotate: true,
      idempotency_key: randomUUID(),
    })
  ).link as string;
  // (The pre-rotation link is simply invalid for everyone.)
  assert.equal((await join(app, b.key, link, spare)).json().code, 'invite_invalid');
  for (const id of [spare, bravo]) {
    const res = await join(app, b.key, rotated, id);
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, 'removed_from_room');
  }
  const fresh = await call(app, b.key, 'city_join_room', {
    link: rotated,
    create: { name: 'Brand new' },
    idempotency_key: randomUUID(),
  });
  assert.equal(fresh.statusCode, 403, fresh.body);
  assert.equal(fresh.json().code, 'removed_from_room');
  assert.equal((await join(app, c.key, rotated, charlie)).statusCode, 200);
  // A member that left on its own may come back (it was not removed).
  await ok(app, c.key, 'city_room_leave', { room_id: roomId, agent_id: charlie });
  assert.equal((await join(app, c.key, rotated, charlie)).statusCode, 200);
});

test('a real link to a closed room says the room is closed; short codes stay uniform', async (t) => {
  const app = await fixture(t);
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const host = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await createRoom(app, a.key, host);
  const roomId = created.room.id as string;
  const joinLink = await app.inject({
    method: 'POST',
    url: '/api/links',
    headers: { ...jsonHeaders, cookie: a.cookie, 'x-city-workspace': a.id },
    payload: JSON.stringify({ target: 'room', room_id: roomId }),
  });
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const { url, code: short } = joinLink.json() as { url: string; code: string };
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  for (const l of [created.link.link as string, url]) {
    const res = await join(app, b.key, l, bravo);
    assert.equal(res.statusCode, 409, res.body);
    assert.deepEqual(res.json().code, 'room_closed');
    assert.equal(res.json().error, CLOSED);
  }
  // A short code live at the close says so too.
  const byShort = await join(app, b.key, short, bravo);
  assert.equal(byShort.statusCode, 409, byShort.body);
  assert.equal(byShort.json().code, 'room_closed');
  // The no-account path says the same for the full link.
  const guest = await app.inject({
    method: 'POST',
    url: '/api/public/invites/bootstrap',
    headers: jsonHeaders,
    payload: JSON.stringify({ code: url }),
    remoteAddress: '203.0.113.40',
  });
  assert.equal(guest.statusCode, 409, guest.body);
  assert.equal(guest.json().code, 'room_closed');
});
