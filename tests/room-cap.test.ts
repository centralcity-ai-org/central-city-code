import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { runMigrations, listMigrations } from '../server/migrations.js';
import { loadLimits } from '../server/limits.js';
import { SHORT_CODE_LIMITS } from '../server/links/short-code.js';
import { INVITE_PICKUPS_PER_SOURCE } from '../server/links/invites.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';
import { registerMessagingMigration } from '../server/messaging/schema.js';
import { registerAiWorkspacesMigration } from '../server/workspaces/schema.js';
import { registerCrossConnectionsMigration } from '../server/connections/schema.js';
import { registerRoomsMigration } from '../server/rooms/schema.js';
import { registerJoinLinksMigration } from '../server/links/schema.js';
import { registerWakeMigration } from '../server/wake/schema.js';
import { registerResultsMigration } from '../server/results/schema.js';
import { registerRoomFormatMigration } from '../server/rooms/format-schema.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-cap-test-root-secret-000';

/**
 * Room member caps. The member cap defaults to 10,000 (at most 10,000); open rooms still at an
 * old default are raised (migration 32: 20 -> 100, migration 34: 100 -> 10,000, only raises), the
 * host changes the cap in the console, and the anonymous admission budgets allow a room of 100
 * guests from one address. Synthetic data.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};

test('limits: member cap defaults, pickups per source and the short-code budget', () => {
  assert.equal(ROOM_LIMITS.memberCapDefault, 10_000);
  assert.equal(ROOM_LIMITS.memberCapMax, 10_000);
  const caps = loadLimits({});
  assert.equal(caps.roomMembersMax, 10_000);
  assert.equal(caps.roomMembersDefault, 10_000);
  assert.equal(loadLimits({ CITY_LIMIT_ROOM_MEMBERS_MAX: '500' }).roomMembersMax, 500);
  assert.equal(loadLimits({ CITY_LIMIT_ROOM_MEMBERS_DEFAULT: '100' }).roomMembersDefault, 100);
  assert.throws(() => loadLimits({ CITY_LIMIT_ROOM_MEMBERS_MAX: 'many' }), /ROOM_MEMBERS_MAX/);
  assert.equal(caps.unclaimedCreatesPerSourcePerHour, 200);
  assert.equal(caps.unclaimedCreatesPerSitePerHour, 200);
  assert.equal(caps.unclaimedCreatesPerNetworkPerHour, 300);
  assert.equal(caps.unclaimedCreatesPerRegionPerHour, 500);
  // Environment overrides still win.
  assert.equal(
    loadLimits({ CITY_LIMIT_UNCLAIMED_CREATES_PER_SOURCE_PER_HOUR: '40' })
      .unclaimedCreatesPerSourcePerHour,
    40,
  );
  assert.equal(INVITE_PICKUPS_PER_SOURCE, 100);
  assert.equal(SHORT_CODE_LIMITS.attemptsPerAddressPerHour, 100);
});

test('migration 32 raises open rooms at 20 to 100, and nothing else', async (t) => {
  registerMessagingMigration();
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  registerRoomsMigration();
  registerJoinLinksMigration();
  registerWakeMigration();
  registerResultsMigration();
  registerRoomFormatMigration();
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  const before = listMigrations().filter((migration) => migration.version < 32);
  await runMigrations(db, before);
  await db.exec(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES ('op','Op','op','x','y');`,
  );
  const room = (id: string, cap: number, closed: number | null) =>
    db.query(
      `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,closed_at,idempotency_key,request_hash)
       VALUES ($1,$1,$1,'op','agent',$2,'full',1000,0,$3,$1,'h')`,
      [id, cap, closed],
    );
  await room('open-20', 20, null);
  await room('open-12', 12, null);
  await room('closed-20', 20, 5);
  const result = await runMigrations(db, listMigrations());
  assert.ok(result.applied.includes(32));
  const caps = Object.fromEntries(
    (
      await db.query<{ id: string; member_cap: number }>('SELECT id, member_cap FROM rooms')
    ).rows.map((row) => [row.id, row.member_cap]),
  );
  // Migration 34 then raises the open rooms at 100 to 10,000.
  assert.deepEqual(caps, { 'open-20': 10_000, 'open-12': 12, 'closed-20': 20 });
});

test('migration 34 raises open rooms at 100 to 10,000, and nothing else', async (t) => {
  registerMessagingMigration();
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  registerRoomsMigration();
  registerJoinLinksMigration();
  registerWakeMigration();
  registerResultsMigration();
  registerRoomFormatMigration();
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < 34),
  );
  await db.exec(
    `INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES ('op','Op','op','x','y');`,
  );
  const room = (id: string, cap: number, closed: number | null) =>
    db.query(
      `INSERT INTO rooms(id,slug,name,host_owner_id,host_agent_id,member_cap,history,link_ttl_ms,created_at,closed_at,idempotency_key,request_hash)
       VALUES ($1,$1,$1,'op','agent',$2,'full',1000,0,$3,$1,'h')`,
      [id, cap, closed],
    );
  await room('open-100', 100, null);
  await room('open-60', 60, null);
  await room('closed-100', 100, 5);
  const result = await runMigrations(db, listMigrations());
  assert.ok(result.applied.includes(34));
  const caps = Object.fromEntries(
    (
      await db.query<{ id: string; member_cap: number }>('SELECT id, member_cap FROM rooms')
    ).rows.map((row) => [row.id, row.member_cap]),
  );
  assert.deepEqual(caps, { 'open-100': 10_000, 'open-60': 60, 'closed-100': 100 });
});

test('the host changes the member cap (never below the members), logged; others cannot', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  let address = 60;
  const post = (url: string, body: unknown, extra = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address++}`,
    });
  const account = async (name: string) => {
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic room cap password',
    });
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Cap host');
  const created = await post(
    '/api/rooms',
    { name: 'Big room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.json().room.member_cap, 10_000);
  const roomId = created.json().room.id as string;
  const member = await account('Member');
  const joined = await post(
    `/api/rooms/${roomId}/join`,
    { link: created.json().link.link, agent_id: member.agentId, idempotency_key: randomUUID() },
    { cookie: member.cookie },
  );
  assert.equal(joined.statusCode, 200, joined.body);
  const set = (cookie: string, cap: number) =>
    post(`/api/rooms/${roomId}/settings`, { member_cap: cap }, { cookie });
  const lowered = await set(host.cookie, 30);
  assert.equal(lowered.statusCode, 200, lowered.body);
  assert.equal(lowered.json().room.member_cap, 30);
  assert.equal((await set(host.cookie, 1)).statusCode, 400);
  assert.equal((await set(host.cookie, 10_001)).statusCode, 400);
  const raised = await set(host.cookie, 10_000);
  assert.equal(raised.statusCode, 200, raised.body);
  assert.equal(raised.json().room.member_cap, 10_000);
  const below = await set(host.cookie, 2);
  assert.equal(below.statusCode, 200, 'two members, cap two is allowed');
  const other = await set(member.cookie, 50);
  assert.equal(other.statusCode, 403, other.body);
  const snapshot = await app.inject({
    method: 'GET',
    url: '/api/snapshot',
    headers: { ...headers, cookie: host.cookie },
  });
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('members allowed 10000 -> 30'),
    ),
  );
  assert.ok(
    (snapshot.json().events as Array<{ message: string }>).some((e) =>
      e.message.includes('members allowed 30 -> 10000'),
    ),
  );
  // The history setting keeps working on the same route.
  const history = await post(
    `/api/rooms/${roomId}/settings`,
    { history: 'from_join' },
    { cookie: host.cookie },
  );
  assert.equal(history.statusCode, 200, history.body);
});

test('a default join link admits as many joins as the room holds (an earlier test stopped at 24)', async (t) => {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.90') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const registered = await post('/api/auth/register', {
    name: 'Fifty host',
    password: 'Synthetic room cap password',
  });
  const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const agent = await post(
    '/api/agents',
    { name: 'Fifty host agent', capability: 'research', mode: 'hosted' },
    { cookie },
  );
  const room = await post(
    '/api/rooms',
    { name: 'Fifty', agent_id: agent.json().agent.id, idempotency_key: randomUUID() },
    { cookie },
  );
  const roomId = room.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, { cookie });
  assert.equal(link.json().max_uses, 10_000, 'omitted max_uses follows the member cap');
  const explicit = await post(
    '/api/links',
    { target: 'room', room_id: roomId, max_uses: 7 },
    { cookie },
  );
  assert.equal(explicit.json().max_uses, 7, 'an explicit max_uses is kept');
  // A lower cap gives a lower default.
  await post(`/api/rooms/${roomId}/settings`, { member_cap: 30 }, { cookie });
  const lower = await post('/api/links', { target: 'room', room_id: roomId }, { cookie });
  assert.equal(lower.json().max_uses, 30);
  await post(`/api/rooms/${roomId}/settings`, { member_cap: 100 }, { cookie });

  // 50 AI guests through the one default link (the /mcp/open path, one source address).
  const code = new URL(link.json().url).pathname.split('/').at(-1)!;
  for (let i = 0; i < 50; i++) {
    const start = await post('/api/public/invites/bootstrap', { code });
    assert.equal(start.statusCode, 200, `guest ${i + 1} bootstrap: ${start.body}`);
    const joined = await post('/api/public/invites/redeem', {
      code,
      handle: start.json().handle,
      name: `Guest ${i + 1}`,
    });
    assert.equal(joined.statusCode, 200, `guest ${i + 1} redeem: ${joined.body}`);
  }
  const members = await app.inject({
    method: 'GET',
    url: `/api/rooms/${roomId}/members`,
    headers: { ...headers, cookie },
  });
  assert.equal(members.json().members.length, 51);
});
