import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import type { RoomLimits } from '../server/rooms/contract.js';
import { PGlite } from '@electric-sql/pglite';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-management-test-root-not-a-real-secret';

/**
 * Room management (docs/ROOMS.md "Room management", migration 35): rename and topic, host delete
 * with confirm_name (tombstone, content erased, links revoked, 410 room_deleted), removal with a
 * reason and an optional rejoin, and the host's mute of a member. Console REST, the MCP host tools
 * and the no-account guest tools (/mcp/open).
 * Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
type Owner = { id: string; key: string; cookie: string };
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  rooms: Partial<RoomLimits> = {},
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, rooms });
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
/** The owner console (a signed-in co-owner acting in the workspace). */
function rest(app: App, who: Owner, method: string, url: string, body?: unknown) {
  return app.inject({
    method: method as 'GET',
    url,
    headers: { ...jsonHeaders, cookie: who.cookie, 'x-city-workspace': who.id },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
let addressCounter = 1;
/** An AI-owned workspace claimed by a person, with a key holding every scope. */
async function owner(app: App, name: string): Promise<Owner> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.30`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Owner ${addressCounter}`,
      password: 'Synthetic management password',
    }),
    remoteAddress: `198.51.${addressCounter++}.31`,
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
/** A room of host `a` with member agents of `b` (and more owners when given). */
async function room(app: App, name = 'Synthetic desk') {
  const a = await owner(app, 'Host workspace');
  const b = await owner(app, 'Member workspace');
  const hostAgent = await agent(app, a.key, 'Host desk');
  const bravo = await agent(app, b.key, 'Bravo');
  const created = await ok(app, a.key, 'city_create_room', {
    agent_id: hostAgent,
    name,
    topic: 'First topic',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const link = created.link.link as string;
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo, idempotency_key: randomUUID() });
  return { a, b, hostAgent, bravo, roomId, link };
}
async function texts(app: App, who: Owner, roomId: string) {
  const res = await rest(app, who, 'GET', `/api/rooms/${roomId}/messages?limit=100`);
  assert.equal(res.statusCode, 200, res.body);
  return (res.json().messages as Array<{ text: string; sender_kind: string }>).map(
    (m) => `${m.sender_kind}: ${m.text}`,
  );
}

test('PATCH /api/rooms/:room renames and changes the topic (host only, cleaned, one line each)', async (t) => {
  const app = await fixture(t);
  const { a, b, roomId } = await room(app);
  // Bidi and zero-width characters are removed; whitespace collapses.
  const renamed = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, {
    name: '  Design‮  re​view ',
    topic: 'Ship the⁦ room page',
  });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().changed, true);
  assert.equal(renamed.json().room.name, 'Design review');
  assert.equal(renamed.json().room.topic, 'Ship the room page');
  assert.deepEqual((await texts(app, a, roomId)).slice(-2), [
    'system: The host renamed the room.',
    'system: The host updated the room topic.',
  ]);
  // The same values again: nothing changes, no line.
  const same = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Design review' });
  assert.equal(same.json().changed, false);
  assert.equal((await texts(app, a, roomId)).length, 2);
  // Clearing the topic is a change.
  const cleared = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { topic: '' });
  assert.equal(cleared.json().room.topic, '');
  // Validation as at creation: 1..80 characters, no control characters; empty after cleaning.
  for (const [body, code] of [
    [{ name: 'x'.repeat(81) }, 400],
    [{ name: 'line\nbreak' }, 400],
    [{ name: '​‎' }, 400],
    [{}, 400],
    [{ name: 'Fine', slug: 'nope' }, 400],
    [{ topic: 'y'.repeat(281) }, 400],
  ] as const) {
    const res = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, body);
    assert.equal(res.statusCode, code, `${JSON.stringify(body)}: ${res.body}`);
  }
  const empty = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: '​‎' });
  assert.equal(empty.json().code, 'invalid_name');
  // A member is told it is not the host; an outsider learns nothing.
  const member = await rest(app, b, 'PATCH', `/api/rooms/${roomId}`, { name: 'Mine now' });
  assert.equal(member.statusCode, 403);
  assert.equal(member.json().code, 'host_required');
  const c = await owner(app, 'Outsider workspace');
  const outsider = await rest(app, c, 'PATCH', `/api/rooms/${roomId}`, { name: 'Mine now' });
  assert.equal(outsider.statusCode, 404);
  // The MCP host tool takes name and topic too.
  const tool = await ok(app, a.key, 'city_room_update', { room_id: roomId, name: 'Tool name' });
  assert.equal(tool.room.name, 'Tool name');
  assert.equal(tool.changed, true);
  // A closed room keeps its name.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const closed = await rest(app, a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Too late' });
  assert.equal(closed.statusCode, 409);
  assert.equal(closed.json().code, 'room_closed');
});

test('remove with a reason: only the removed member sees it; the rejoin block is the default', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const removed = await rest(app, a, 'POST', `/api/rooms/${roomId}/members/${bravo}/remove`, {
    reason: 'Off‮ topic,\n  again',
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json(), { room_id: roomId, agent_id: bravo, removed: true });
  // The thread says who was removed, never why.
  const thread = await texts(app, a, roomId);
  assert.equal(thread.at(-1), 'system: Bravo was removed by the host.');
  assert.ok(!thread.some((line) => line.includes('Off topic')));
  // The removed owner hears the reason (cleaned) on every read, over REST and MCP.
  const read = await rest(app, b, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(read.statusCode, 403);
  assert.equal(read.json().code, 'removed_from_room');
  assert.deepEqual(read.json().details, { reason: 'Off topic, again', may_rejoin: false });
  assert.match(read.json().error, /Off topic, again/);
  const tool = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(tool.statusCode, 403, tool.body);
  assert.equal(tool.json().code, 'removed_from_room');
  // Blocked by default: the owner cannot rejoin with any agent and a live link.
  const other = await agent(app, b.key, 'Bravo two');
  const rejoin = await call(app, b.key, 'city_join_room', {
    link,
    agent_id: other,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejoin.statusCode, 403, rejoin.body);
  assert.equal(rejoin.json().code, 'removed_from_room');
  // Bounds: at most 200 characters, never a credential, no unknown fields.
  const c = await owner(app, 'Third workspace');
  const charlie = await agent(app, c.key, 'Charlie');
  await ok(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  for (const [body, code] of [
    [{ reason: 'x'.repeat(201) }, 'invalid_request'],
    [{ reason: `use crr_${'A'.repeat(43)}` }, 'credential_in_message'],
    [{ block_rejoin: 'no' }, 'invalid_request'],
    [{ ban: true }, 'invalid_request'],
  ] as const) {
    const res = await rest(app, a, 'POST', `/api/rooms/${roomId}/members/${charlie}/remove`, body);
    assert.equal(res.statusCode, 400, res.body);
    if (code === 'credential_in_message') assert.equal(res.json().code, code);
  }
});

test('block_rejoin: false lets the removed owner rejoin with a live link (MCP host tool)', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const removed = await ok(app, a.key, 'city_room_remove', {
    room_id: roomId,
    agent_id: bravo,
    reason: 'Take a break',
    block_rejoin: false,
  });
  assert.equal(removed.removed, true);
  const read = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(read.statusCode, 403);
  assert.deepEqual(read.json().details, { reason: 'Take a break', may_rejoin: true });
  // The same agent rejoins in place; the reason is gone with the removal.
  const rejoined = await ok(app, b.key, 'city_join_room', {
    link,
    agent_id: bravo,
    idempotency_key: randomUUID(),
  });
  assert.equal(rejoined.joined, true);
  const row = (
    await app.city.db.query<{
      removed_at: string | null;
      removal_reason: string | null;
      rejoin_allowed: boolean;
    }>('SELECT removed_at, removal_reason, rejoin_allowed FROM room_members WHERE agent_id=$1', [
      bravo,
    ])
  ).rows[0]!;
  assert.deepEqual(row, { removed_at: null, removal_reason: null, rejoin_allowed: false });
  await ok(app, b.key, 'city_room_read', { room_id: roomId });
});

test('mute: host only; a muted owner cannot post (any agent, after rejoin) and sees the reason', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, hostAgent, roomId, link } = await room(app);
  const bOwner = (
    await app.city.db.query<{ owner_id: string }>(
      'SELECT owner_id FROM room_members WHERE agent_id=$1',
      [bravo],
    )
  ).rows[0]!.owner_id;
  await app.city.db.query(
    `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by)
      VALUES('hook-bravo',$1,$2,'https://hooks.example.test/wake',ARRAY['room_post','mention'],'00',0,'test')`,
    [bravo, bOwner],
  );
  const say = (text: string) =>
    rest(app, a, 'POST', `/api/rooms/${roomId}/messages`, {
      text,
      idempotency_key: randomUUID(),
    });
  const counts = async () => {
    const q = async (sql: string) =>
      Number((await app.city.db.query<{ n: string }>(sql, [bravo])).rows[0]!.n);
    return {
      mentions: await q('SELECT count(*) AS n FROM mentions WHERE agent_id=$1'),
      outbox: await q('SELECT count(*) AS n FROM wake_outbox WHERE agent_id=$1'),
    };
  };
  const bravoPost = (text = 'Hello') =>
    call(app, b.key, 'city_room_post', {
      room_id: roomId,
      agent_id: bravo,
      text,
      idempotency_key: randomUUID(),
    });
  assert.equal((await say('@Bravo first')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 1 });
  await app.city.db.query('DELETE FROM wake_outbox');

  // Only the host mutes: a member hears host_required, an outsider 404; the host is never muted.
  const c = await owner(app, 'Outsider workspace');
  const byMember = await rest(app, b, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(byMember.statusCode, 403, byMember.body);
  assert.equal(byMember.json().code, 'host_required');
  const byOutsider = await rest(app, c, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(byOutsider.statusCode, 404, byOutsider.body);
  const host = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: hostAgent,
    muted: true,
  });
  assert.equal(host.statusCode, 400, host.body);
  assert.equal(host.json().code, 'cannot_mute_host');
  // Owner isolation: an agent that is not in this room (another owner's, another room's) is 404.
  const charlie = await agent(app, c.key, 'Charlie');
  const stranger = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: charlie,
    muted: true,
  });
  assert.equal(stranger.statusCode, 404, stranger.body);
  assert.equal(stranger.json().code, 'member_not_found');
  // Bounds: agent_id and muted required, reason at most 200 characters and never a credential.
  for (const [body, code] of [
    [{ muted: true }, 'invalid_request'],
    [{ agent_id: bravo }, 'invalid_request'],
    [{ agent_id: bravo, muted: true, reason: 'x'.repeat(201) }, 'invalid_request'],
    [
      { agent_id: bravo, muted: true, reason: `use crr_${'A'.repeat(43)}` },
      'credential_in_message',
    ],
  ] as const) {
    const res = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, body);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)}: ${res.body}`);
    if (code === 'credential_in_message') assert.equal(res.json().code, code);
  }

  const muted = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
    reason: 'Too‮ many\n pings',
  });
  assert.equal(muted.statusCode, 200, muted.body);
  assert.deepEqual(muted.json(), {
    room_id: roomId,
    agent_id: bravo,
    muted: true,
    reason: 'Too many pings',
  });
  // Nothing in the thread says so.
  assert.ok(!(await texts(app, a, roomId)).some((line) => line.includes('pings')));
  // The muted owner cannot post, over MCP or REST, and hears the reason.
  const refused = await bravoPost();
  assert.equal(refused.statusCode, 403, refused.body);
  assert.equal(refused.json().code, 'muted_in_room');
  assert.deepEqual(refused.json().details, { reason: 'Too many pings' });
  assert.match(refused.json().error, /Too many pings/);
  const viaRest = await rest(app, b, 'POST', `/api/rooms/${roomId}/messages`, {
    agent_id: bravo,
    text: 'From the console',
    idempotency_key: randomUUID(),
  });
  assert.equal(viaRest.statusCode, 403, viaRest.body);
  assert.equal(viaRest.json().code, 'muted_in_room');
  // Its console view says so, with the reason; the host's view does not.
  const listed = (await rest(app, b, 'GET', '/api/rooms'))
    .json()
    .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal(listed.muted, true);
  assert.equal(listed.mute_reason, 'Too many pings');
  const hostView = (await rest(app, a, 'GET', '/api/rooms'))
    .json()
    .rooms.find((r: { id: string }) => r.id === roomId);
  assert.equal(hostView.muted, false);
  // Another agent of the same owner is silenced too (the mute is per owner, like a removal).
  const bravo2 = await agent(app, b.key, 'Bravo two');
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo2, idempotency_key: randomUUID() });
  const second = await call(app, b.key, 'city_room_post', {
    room_id: roomId,
    agent_id: bravo2,
    text: 'Sneaky',
    idempotency_key: randomUUID(),
  });
  assert.equal(second.statusCode, 403, second.body);
  assert.equal(second.json().code, 'muted_in_room');
  // Leaving and rejoining keeps the mute.
  await ok(app, b.key, 'city_room_leave', { room_id: roomId, agent_id: bravo });
  await ok(app, b.key, 'city_join_room', { link, agent_id: bravo, idempotency_key: randomUUID() });
  assert.equal((await bravoPost()).json().code, 'muted_in_room');
  // Not woken (it could not answer), and still a reader of every message.
  assert.equal((await say('@Bravo second')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 1, outbox: 0 });
  // Per owner: the owner's other agent is not woken or mentioned either.
  assert.equal((await say('@Bravo two are you there')).statusCode, 201);
  assert.equal(
    Number(
      (
        await app.city.db.query<{ n: string }>(
          'SELECT count(*) AS n FROM mentions WHERE agent_id=$1',
          [bravo2],
        )
      ).rows[0]!.n,
    ),
    0,
  );
  const page = await ok(app, b.key, 'city_room_read', { room_id: roomId, since: 0 });
  assert.ok(page.messages.some((m: { text: string }) => m.text === '@Bravo second'));
  // The host lists mutes; nobody else can.
  const mutes = await rest(app, a, 'GET', `/api/rooms/${roomId}/mutes`);
  assert.equal(mutes.statusCode, 200, mutes.body);
  assert.deepEqual(
    mutes
      .json()
      .muted.map((m: { agent_id: string; reason: string; active: boolean }) => [
        m.agent_id,
        m.reason,
        m.active,
      ]),
    [[bravo, 'Too many pings', true]],
  );
  assert.equal((await rest(app, b, 'GET', `/api/rooms/${roomId}/mutes`)).statusCode, 403);
  assert.equal((await rest(app, c, 'GET', `/api/rooms/${roomId}/mutes`)).statusCode, 404);

  // Unmuting lifts it for the whole owner.
  const unmuted = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo2,
    muted: false,
  });
  assert.equal(unmuted.statusCode, 200, unmuted.body);
  assert.equal(unmuted.json().muted, false);
  assert.equal((await bravoPost('Back')).statusCode, 200);
  assert.equal((await say('@Bravo third')).statusCode, 201);
  assert.deepEqual(await counts(), { mentions: 2, outbox: 1 });
  assert.deepEqual((await rest(app, a, 'GET', `/api/rooms/${roomId}/mutes`)).json().muted, []);
  // A closed room takes no mutes.
  await ok(app, a.key, 'city_room_close', { room_id: roomId });
  const closed = await rest(app, a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: bravo,
    muted: true,
  });
  assert.equal(closed.statusCode, 409, closed.body);
});

test('rename and remove are host only over MCP too; a blocked owner cannot rejoin by any link', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app);
  const c = await owner(app, 'Third workspace');
  const charlie = await agent(app, c.key, 'Charlie');
  await ok(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  // A member cannot rename or remove; an outsider learns nothing.
  const rename = await call(app, b.key, 'city_room_update', { room_id: roomId, name: 'Mine' });
  assert.equal(rename.statusCode, 403, rename.body);
  assert.equal(rename.json().code, 'host_required');
  const remove = await call(app, b.key, 'city_room_remove', { room_id: roomId, agent_id: charlie });
  assert.equal(remove.statusCode, 403, remove.body);
  const restRemove = await rest(
    app,
    b,
    'POST',
    `/api/rooms/${roomId}/members/${charlie}/remove`,
    {},
  );
  assert.equal(restRemove.statusCode, 403, restRemove.body);
  const d = await owner(app, 'Outsider workspace');
  const outsider = await call(app, d.key, 'city_room_update', { room_id: roomId, topic: 'x' });
  assert.equal(outsider.statusCode, 404, outsider.body);
  // Delete and mute are console only for the host; a member's DELETE is host_required.
  assert.equal(
    (await rest(app, b, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'Synthetic desk' }))
      .statusCode,
    403,
  );

  // Blocked removal: every way back in is refused, including a link minted afterwards.
  await ok(app, a.key, 'city_room_remove', { room_id: roomId, agent_id: bravo, reason: 'Spam' });
  const rotated = await ok(app, a.key, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  const joinLink = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const fresh = await agent(app, b.key, 'Bravo again');
  const attempts = [
    await call(app, b.key, 'city_join_room', {
      link: rotated.link,
      agent_id: bravo,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: rotated.link,
      agent_id: fresh,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: joinLink.json().url,
      agent_id: fresh,
      idempotency_key: randomUUID(),
    }),
    await call(app, b.key, 'city_join_room', {
      link: rotated.join_link,
      create: { name: 'Brand new' },
      idempotency_key: randomUUID(),
    }),
    ...(rotated.short_code
      ? [
          await call(app, b.key, 'city_join_room', {
            link: rotated.short_code,
            agent_id: fresh,
            idempotency_key: randomUUID(),
          }),
        ]
      : []),
    // The signed-in person joining as themselves.
    await rest(app, b, 'POST', '/api/rooms/join', {
      link: rotated.link,
      idempotency_key: randomUUID(),
    }),
  ];
  for (const res of attempts) {
    assert.equal(res.statusCode, 403, res.body);
    assert.equal(res.json().code, 'removed_from_room');
    assert.deepEqual(res.json().details, { reason: 'Spam', may_rejoin: false });
  }
  const active = await app.city.db.query(
    'SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=(SELECT owner_id FROM room_members WHERE agent_id=$2) AND removed_at IS NULL',
    [roomId, bravo],
  );
  assert.equal(active.rows.length, 0);
});

test('DELETE /api/rooms/:room: confirm_name, erase, revoke, 410 for members, 404 for others', async (t) => {
  const app = await fixture(t);
  const { a, b, bravo, roomId, link } = await room(app, 'Delete me');
  const joinLink = await rest(app, a, 'POST', '/api/links', { target: 'room', room_id: roomId });
  assert.equal(joinLink.statusCode, 201, joinLink.body);
  const said = await rest(app, b, 'POST', `/api/rooms/${roomId}/messages`, {
    text: 'Secret plan for @Host desk',
    idempotency_key: randomUUID(),
  });
  assert.equal(said.statusCode, 201, said.body);
  await app.city.db.query(
    `INSERT INTO room_tasks(id,room_id,number,title,status,created_by_agent_id,created_by_owner_id,created_at,updated_at,idempotency_key,request_hash)
      VALUES('task-1',$1,1,'Synthetic task','open',$2,'owner',0,0,'k','h')`,
    [roomId, bravo],
  );
  // Host only; the name must match exactly.
  const member = await rest(app, b, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Delete me',
  });
  assert.equal(member.statusCode, 403);
  assert.equal(member.json().code, 'host_required');
  for (const confirm_name of ['delete me', 'Delete me ', '']) {
    const res = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name });
    assert.equal(res.statusCode, 400, res.body);
    assert.equal(res.json().code, 'confirm_name_mismatch');
  }
  assert.equal((await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {})).statusCode, 400);

  const deleted = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Delete me',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { room_id: roomId, deleted: true });
  // Both sides hear about it in their activity log (members through the chunked notices).
  for (const agentId of [bravo, null]) {
    const ownerId = agentId
      ? (
          await app.city.db.query<{ owner_id: string }>(
            'SELECT owner_id FROM room_members WHERE agent_id=$1',
            [agentId],
          )
        ).rows[0]!.owner_id
      : (
          await app.city.db.query<{ host_owner_id: string }>(
            'SELECT host_owner_id FROM rooms WHERE id=$1',
            [roomId],
          )
        ).rows[0]!.host_owner_id;
    const events = (
      await app.city.db.query<{ events: Array<{ type: string; message: string }> }>(
        "SELECT data->'events' AS events FROM workspaces WHERE operator_id=$1",
        [ownerId],
      )
    ).rows[0]!.events;
    const notice = events.filter((e) => e.type === 'room.deleted');
    assert.equal(notice.length, 1, `${agentId ? 'member' : 'host'} notice`);
    assert.ok(!notice[0]!.message.includes('Delete me'), 'no room name in the notice');
  }

  // Gone from every list; the host and former members hear 410, others 404.
  for (const who of [a, b]) {
    const rooms = (await rest(app, who, 'GET', '/api/rooms')).json().rooms as Array<{ id: string }>;
    assert.ok(!rooms.some((r) => r.id === roomId));
    const read = await rest(app, who, 'GET', `/api/rooms/${roomId}/messages`);
    assert.equal(read.statusCode, 410, read.body);
    assert.equal(read.json().code, 'room_deleted');
  }
  const tool = await call(app, b.key, 'city_room_read', { room_id: roomId });
  assert.equal(tool.json().code, 'room_deleted');
  const c = await owner(app, 'Outsider workspace');
  const outsider = await rest(app, c, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(outsider.statusCode, 404);
  // Again: the room is already deleted.
  const again = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'Delete me' });
  assert.equal(again.statusCode, 410);
  // No link admits anyone: the room link and the join link are revoked.
  const charlie = await agent(app, c.key, 'Charlie');
  const byLink = await call(app, c.key, 'city_join_room', {
    link,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  // A link live when the room ended says it is gone (410), to any holder.
  assert.equal(byLink.statusCode, 410, byLink.body);
  assert.equal(byLink.json().code, 'room_deleted');
  const byCode = await call(app, c.key, 'city_join_room', {
    link: joinLink.json().url,
    agent_id: charlie,
    idempotency_key: randomUUID(),
  });
  assert.equal(byCode.statusCode, 410, byCode.body);
  assert.equal(byCode.json().code, 'room_deleted');
  // Content is erased; the tombstone keeps no name or topic; audit rows stay.
  const count = async (sql: string) =>
    Number((await app.city.db.query<{ n: string }>(sql, [roomId])).rows[0]!.n);
  assert.equal(await count('SELECT count(*) AS n FROM room_messages WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM room_receipts WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM mentions WHERE room_id=$1'), 0);
  assert.equal(await count('SELECT count(*) AS n FROM room_tasks WHERE room_id=$1'), 0);
  assert.equal(
    await count('SELECT count(*) AS n FROM room_links WHERE room_id=$1 AND revoked_at IS NULL'),
    0,
  );
  assert.equal(
    await count('SELECT count(*) AS n FROM join_links WHERE room_id=$1 AND revoked_at IS NULL'),
    0,
  );
  assert.equal(
    await count('SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND removed_at IS NULL'),
    0,
  );
  const tomb = (
    await app.city.db.query<{ name: string; topic: string; deleted_at: string | null }>(
      'SELECT name, topic, deleted_at FROM rooms WHERE id=$1',
      [roomId],
    )
  ).rows[0]!;
  assert.equal(tomb.name, '');
  assert.equal(tomb.topic, '');
  assert.ok(tomb.deleted_at !== null);
  assert.equal(
    await count("SELECT count(*) AS n FROM room_events WHERE room_id=$1 AND action='room.deleted'"),
    1,
  );
});

test('room deletion is rate limited per owner', async (t) => {
  const app = await fixture(t, { deletesPerOwnerPerHour: 2 });
  const { a, roomId } = await room(app);
  for (let i = 0; i < 2; i++) {
    const res = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, { confirm_name: 'wrong' });
    assert.equal(res.statusCode, 400, res.body);
  }
  const limited = await rest(app, a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Synthetic desk',
  });
  assert.equal(limited.statusCode, 429, limited.body);
});

// ---------------------------------------------------------------------------------------------
// Hosted origin: the no-account guest paths (/mcp/open, /api/public/invites) and short codes.

const ORIGIN = 'https://centralcity.ai';
async function hosted(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 10;
  const send = (method: string, url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: method as 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
        ...extra,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address}`,
    });
  const hostedOwner = async (name: string): Promise<Owner> => {
    address++;
    const res = await send('POST', '/api/public/workspaces', {
      name,
      idempotency_key: randomUUID(),
    });
    assert.equal(res.statusCode, 201, res.body);
    const person = await send('POST', '/api/auth/register', {
      name: `Co-owner ${address}`,
      password: 'Synthetic co-owner password',
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const id = res.json().workspace_id as string;
    assert.equal(
      (
        await send(
          'POST',
          '/api/workspaces/claim',
          { claim_token: res.json().claim_token },
          { cookie },
        )
      ).statusCode,
      200,
    );
    const minted = await send(
      'POST',
      '/api/workspace-keys',
      { label: 'room host', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return { id, key: minted.json().workspace_key as string, cookie };
  };
  const tool = (key: string, name: string, args: unknown = {}) =>
    send('POST', `/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const console = (who: Owner, method: string, url: string, body?: unknown) =>
    send(method, url, body, { cookie: who.cookie, 'x-city-workspace': who.id });
  const transport = injectTransport(async (req) => {
    const res = await app.inject({
      method: req.method,
      url: req.path,
      headers: {
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
      remoteAddress: '198.51.100.7',
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  const guestJoin = async (link: string) => {
    const joined = await callOpenTool(transport, 'city_join_invite', {
      invite_link: link,
      name: 'Guest AI',
      idempotency_key: randomUUID(),
    });
    const structured = joined.result?.structuredContent ?? {};
    assert.ok(structured['room_credential'], joined.raw.slice(0, 600));
    return {
      credential: structured['room_credential'] as string,
      agentId: structured['agent_id'] as string,
    };
  };
  const guestPost = (credential: string, text: string) =>
    callOpenTool(transport, 'city_room_post', {
      room_credential: credential,
      text,
      idempotency_key: randomUUID(),
    });
  const setup = async () => {
    const a = await hostedOwner('Host workspace');
    const b = await hostedOwner('Member workspace');
    const hostAgent = (
      await (
        await tool(a.key, 'city_create_agent', {
          name: 'Host desk',
          description: 'Synthetic room host',
          capability: 'research',
          mode: 'external',
          idempotencyKey: randomUUID(),
        })
      ).json()
    ).agent.id as string;
    const bravo = (
      await (
        await tool(b.key, 'city_create_agent', {
          name: 'Bravo',
          description: 'Synthetic room member',
          capability: 'research',
          mode: 'external',
          idempotencyKey: randomUUID(),
        })
      ).json()
    ).agent.id as string;
    const created = await tool(a.key, 'city_create_room', {
      agent_id: hostAgent,
      name: 'Hosted desk',
      idempotency_key: randomUUID(),
    });
    assert.equal(created.statusCode, 200, created.body);
    const roomId = created.json().room.id as string;
    const link = created.json().link as { link: string; join_link: string; short_code: string };
    const joined = await tool(b.key, 'city_join_room', {
      link: link.link,
      agent_id: bravo,
      idempotency_key: randomUUID(),
    });
    assert.equal(joined.statusCode, 200, joined.body);
    return { a, b, bravo, roomId, link };
  };
  return { app, tool, console, transport, guestJoin, guestPost, hostedOwner, setup };
}

test('a muted guest (no account) cannot post over /mcp/open and hears the reason', async (t) => {
  const h = await hosted(t);
  const { a, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const before = await h.guestPost(guest.credential, 'Hi from a guest');
  assert.equal(outcomeErrorCode(before), null, before.raw.slice(0, 600));
  const muted = await h.console(a, 'POST', `/api/rooms/${roomId}/mute`, {
    agent_id: guest.agentId,
    muted: true,
    reason: 'Guest spam',
  });
  assert.equal(muted.statusCode, 200, muted.body);
  const after = await h.guestPost(guest.credential, 'Still here');
  assert.equal(outcomeErrorCode(after), 'muted_in_room', after.raw.slice(0, 600));
  assert.match(after.raw, /Guest spam/);
  // It still reads.
  const read = await callOpenTool(h.transport, 'city_room_read', {
    room_credential: guest.credential,
  });
  assert.equal(outcomeErrorCode(read), null, read.raw.slice(0, 600));
});

test('a deleted room is 410 room_deleted everywhere: tools, links, short codes, guests, wake', async (t) => {
  const h = await hosted(t);
  const { a, b, bravo, roomId, link } = await h.setup();
  const guest = await h.guestJoin(link.join_link);
  const deleted = await h.console(a, 'DELETE', `/api/rooms/${roomId}`, {
    confirm_name: 'Hosted desk',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);

  const expect410 = (
    res: { statusCode: number; body: string; json(): { code: string } },
    what: string,
  ) => {
    assert.equal(res.statusCode, 410, `${what}: ${res.body}`);
    assert.equal(res.json().code, 'room_deleted', what);
  };
  // Member and host: REST, MCP, the wake long-poll and every host control.
  expect410(await h.console(b, 'GET', `/api/rooms/${roomId}/messages?wait=1`), 'wake long-poll');
  expect410(await h.console(b, 'GET', `/api/rooms/${roomId}/members`), 'members');
  expect410(
    await h.console(b, 'POST', `/api/rooms/${roomId}/messages`, {
      text: 'Anyone?',
      idempotency_key: randomUUID(),
    }),
    'post',
  );
  expect410(
    await h.tool(b.key, 'city_room_post', {
      room_id: roomId,
      agent_id: bravo,
      text: 'Anyone?',
      idempotency_key: randomUUID(),
    }),
    'city_room_post',
  );
  expect410(await h.tool(a.key, 'city_room_update', { room_id: roomId, name: 'Back' }), 'update');
  expect410(await h.console(a, 'PATCH', `/api/rooms/${roomId}`, { name: 'Back' }), 'rename');
  expect410(
    await h.console(a, 'POST', `/api/rooms/${roomId}/mute`, { agent_id: bravo, muted: true }),
    'mute',
  );
  expect410(
    await h.console(a, 'POST', `/api/rooms/${roomId}/members/${bravo}/remove`, {}),
    'remove',
  );
  expect410(await h.tool(a.key, 'city_room_link', { room_id: roomId }), 'city_room_link');
  // Links of every kind, to a signed-in newcomer: the room link, the join link, the short code.
  const c = await h.hostedOwner('Newcomer workspace');
  for (const value of [link.link, link.join_link, link.short_code])
    expect410(
      await h.tool(c.key, 'city_join_room', {
        link: value,
        create: { name: 'Newcomer' },
        idempotency_key: randomUUID(),
      }),
      `join with ${value.slice(0, 30)}`,
    );
  expect410(
    await h.console(c, 'POST', '/api/rooms/join', {
      link: link.link,
      idempotency_key: randomUUID(),
    }),
    'person join',
  );
  // No-account guests: joining by link or short code, the REST bootstrap, and a credential
  // holder's tools and renewal.
  for (const value of [link.join_link, link.short_code, link.link]) {
    const joined = await callOpenTool(h.transport, 'city_join_invite', {
      invite_link: value,
      name: 'Late guest',
      idempotency_key: randomUUID(),
    });
    assert.equal(outcomeErrorCode(joined), 'room_deleted', joined.raw.slice(0, 600));
  }
  expect410(
    await h.console(c, 'POST', '/api/public/invites/bootstrap', { code: link.join_link }),
    'bootstrap',
  );
  for (const name of ['city_room_read', 'city_room_post', 'city_room_members', 'city_room_renew']) {
    const res = await callOpenTool(h.transport, name, {
      room_credential: guest.credential,
      ...(name === 'city_room_post' ? { text: 'Hello?', idempotency_key: randomUUID() } : {}),
    });
    assert.equal(outcomeErrorCode(res), 'room_deleted', `${name}: ${res.raw.slice(0, 600)}`);
  }
  // An outsider with no link learns nothing (404).
  const outsider = await h.console(c, 'GET', `/api/rooms/${roomId}/messages`);
  assert.equal(outsider.statusCode, 404, outsider.body);
});
