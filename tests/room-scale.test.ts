import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { ROOM_LIMITS } from '../server/rooms/contract.js';

/**
 * Rooms up to 10,000 members: a PGlite load test. A room with member_cap 10,000 is filled with
 * bulk SQL (synthetic operators, workspaces and member rows), then posting, @mentioning, reading
 * and listing members must each stay within a generous budget, the members list paginates, and
 * a join at the cap is refused with room_full.
 *
 * ROOM_SCALE_MEMBERS sets the room size (default 10,000, the maximum); ROOM_SCALE_BUDGET_MS sets
 * the per-operation budget (default 2,000 ms).
 */
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-room-scale-test-root-secret-000';

const MEMBERS = Math.min(
  Number(process.env.ROOM_SCALE_MEMBERS ?? ROOM_LIMITS.memberCapMax),
  ROOM_LIMITS.memberCapMax,
);
const BUDGET_MS = Number(process.env.ROOM_SCALE_BUDGET_MS ?? 2000);
const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};

test(`a room of ${MEMBERS} members: post, mention, read and list stay fast; the cap holds`, async (t) => {
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
  const db = app.city.db;
  let address = 10;
  const call = (method: 'GET' | 'POST', url: string, cookie: string, body?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      remoteAddress: `203.0.113.${address}`,
    });
  const account = async (name: string) => {
    address++;
    const registered = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: JSON.stringify({ name, password: 'Synthetic room scale password' }),
      remoteAddress: `203.0.113.${address}`,
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await call('POST', '/api/agents', cookie, {
      name: `${name} agent`,
      capability: 'research',
      mode: 'hosted',
    });
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const timed = async <T>(label: string, run: () => Promise<T>) => {
    const start = performance.now();
    const result = await run();
    const ms = Math.round(performance.now() - start);
    t.diagnostic(`${label}: ${ms} ms`);
    assert.ok(ms < BUDGET_MS, `${label} took ${ms} ms (budget ${BUDGET_MS} ms)`);
    return result;
  };

  const host = await account('Scale host');
  const created = await call('POST', '/api/rooms', host.cookie, {
    name: 'Scale room',
    agent_id: host.agentId,
    member_cap: MEMBERS,
    idempotency_key: randomUUID(),
  });
  assert.equal(created.statusCode, 201, created.body);
  const room = created.json().room as { id: string; member_cap: number };
  assert.equal(room.member_cap, MEMBERS);

  // Bulk fixture: MEMBERS - 1 synthetic unclaimed guests with one agent each, like invited AIs.
  const fill = performance.now();
  const others = MEMBERS - 1;
  const base = Date.now() - 86_400_000;
  await db.query(
    `INSERT INTO operators(id,name,name_key,password_hash,salt,kind)
       SELECT 'scale-owner-' || i, 'Room guest', 'scale-owner-' || i, '!', '!', 'unclaimed'
         FROM generate_series(1, $1::int) AS i`,
    [others],
  );
  await db.query(
    `INSERT INTO workspaces(operator_id,data)
       SELECT 'scale-owner-' || i, jsonb_build_object(
         'paused', false, 'connections', '[]'::jsonb, 'jobs', '[]'::jsonb, 'events', '[]'::jsonb,
         'agents', jsonb_build_array(jsonb_build_object(
           'id', md5('scale-agent-' || i)::uuid::text, 'name', 'Scale agent ' || i,
           'description', '', 'capability', 'research', 'mode', 'external', 'isDemo', false,
           'lastSeenAt', null, 'createdAt', '2026-01-01T00:00:00.000Z', 'revokedAt', null,
           'lastSequence', -1, 'announcedOnline', false)))
         FROM generate_series(1, $1::int) AS i`,
    [others],
  );
  await db.query(
    `INSERT INTO room_members(room_id,agent_id,owner_id,role,owner_label,visible_from_seq,joined_at,joined_by,last_read_seq)
       SELECT $1, md5('scale-agent-' || i)::uuid::text, 'scale-owner-' || i, 'member',
              'Scale owner ' || i, 0, $3::bigint + i, 'load test', 0
         FROM generate_series(1, $2::int) AS i`,
    [room.id, others, base],
  );
  t.diagnostic(`bulk fixture of ${others} members: ${Math.round(performance.now() - fill)} ms`);
  assert.equal(
    Number(
      (
        await db.query<{ n: string }>(
          'SELECT count(*) AS n FROM room_members WHERE room_id=$1 AND removed_at IS NULL',
          [room.id],
        )
      ).rows[0]!.n,
    ),
    MEMBERS,
  );

  // Posting (plain) and posting with an @mention (mention resolution over every member).
  const plain = await timed('post', () =>
    call('POST', `/api/rooms/${room.id}/messages`, host.cookie, {
      text: 'Hello everyone in the scale room.',
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(plain.statusCode, 201, plain.body);
  const target = Math.max(1, Math.floor(others / 2));
  const mention = await timed('post with @mention', () =>
    call('POST', `/api/rooms/${room.id}/messages`, host.cookie, {
      text: `@"Scale agent ${target}" please check the numbers.`,
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(mention.statusCode, 201, mention.body);
  const mentioned = (
    await db.query<{ agent_id: string }>(
      "SELECT agent_id FROM mentions WHERE source_kind='room' AND source_id=$1",
      [mention.json().message.id],
    )
  ).rows.map((row) => row.agent_id);
  assert.equal(mentioned.length, 1, 'exactly the mentioned member is recorded');

  // Reading the thread.
  const read = await timed('read', () =>
    call('GET', `/api/rooms/${room.id}/messages`, host.cookie),
  );
  assert.equal(read.statusCode, 200, read.body);
  assert.equal(read.json().room.member_count, MEMBERS);
  assert.equal(read.json().messages.length, 2);

  // Members: the first page without parameters, then every page by cursor.
  const first = await timed('members, first page', () =>
    call('GET', `/api/rooms/${room.id}/members`, host.cookie),
  );
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().members.length, Math.min(MEMBERS, ROOM_LIMITS.membersPageSizeDefault));
  assert.equal(typeof first.json().next_cursor, MEMBERS > 500 ? 'string' : 'undefined');
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await timed(`members page ${pages + 1}`, () =>
      call(
        'GET',
        `/api/rooms/${room.id}/members?limit=${ROOM_LIMITS.membersPageSize}${cursor ? `&cursor=${cursor}` : ''}`,
        host.cookie,
      ),
    );
    assert.equal(page.statusCode, 200, page.body);
    for (const member of page.json().members as Array<{ id: string }>) seen.add(member.id);
    cursor = page.json().next_cursor as string | undefined;
    pages++;
  } while (cursor);
  assert.equal(seen.size, MEMBERS, 'every member exactly once across pages');
  assert.equal(pages, Math.ceil(MEMBERS / ROOM_LIMITS.membersPageSize));
  const bad = await call('GET', `/api/rooms/${room.id}/members?cursor=not-a-cursor`, host.cookie);
  assert.equal(bad.statusCode, 400, bad.body);

  // The room is at its cap: one more join is refused.
  const late = await account('Late member');
  const joined = await timed('join at the cap', () =>
    call('POST', `/api/rooms/${room.id}/join`, late.cookie, {
      link: created.json().link.link,
      agent_id: late.agentId,
      idempotency_key: randomUUID(),
    }),
  );
  assert.equal(joined.statusCode, 409, joined.body);
  assert.equal(joined.json().code, 'room_full');
});
