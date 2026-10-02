import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eraseElricOwner } from '../server/elric/erase.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Account deletion erases the owner's Elric rows (turns, posts, pending actions, invocations,
 * usage, agent, identity) and keeps only anonymous cost totals for the operator's cost report.
 * elric_turns stays append-only for every other path.
 */
const PER_OWNER = [
  ['elric_turns', 'owner_id'],
  ['elric_posts', 'owner_id'],
  ['elric_pending_actions', 'owner_id'],
  ['elric_invocations', 'owner_id'],
  ['elric_usage', 'owner_id'],
  ['elric_agents', 'owner_id'],
  ['elric_verified_identities', 'operator_id'],
] as const;

test('eraseElricOwner: removes one owner, keeps the other, keeps anonymous cost totals', async (t) => {
  const f = await elricFixture(t);
  const a = await f.scene('Room A');
  const b = await f.scene('Room B');
  for (const s of [a, b]) {
    f.small.push({ text: 'An answer.' });
    await f.say(s.owner, s.room, '@Elric what is next?', s.person);
    await f.elric.drain();
    await f.db.query(
      `INSERT INTO elric_pending_actions(id,owner_id,agent_id,room_id,tool,args,args_hash,status,
         expires_at,created_at) VALUES ($1,$2,$3,$4,'t','{}','h','pending',$5,$5)`,
      [randomUUID(), s.owner.operatorId, s.elricId, s.room.id, f.now()],
    );
  }
  const count = async (table: string, column: string, id: string) =>
    Number(
      (
        await f.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column}=$1`,
          [id],
        )
      ).rows[0].n,
    );
  for (const [table, column] of PER_OWNER)
    assert.ok((await count(table, column, a.owner.operatorId)) > 0, `${table} seeded`);

  const good = randomBytes(32).toString('base64url');
  const before = process.env.CITY_OPS_SECRET;
  process.env.CITY_OPS_SECRET = good;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  });
  const report = async () =>
    (
      await f.app.inject({
        method: 'GET',
        url: '/api/ops/elric/cost?days=2',
        headers: { 'x-city-request': '1', authorization: `Bearer ${good}` },
      })
    ).json();
  const reportBefore = await report();
  const globalBefore = (await f.db.query('SELECT * FROM elric_global_usage ORDER BY day')).rows;
  assert.equal(reportBefore.cumulative.total.turns, 2);

  const result = await eraseElricOwner(f.db, a.owner.operatorId);
  assert.equal(result.turns, 1);
  assert.equal(result.identities, 1);
  for (const [table, column] of PER_OWNER) {
    assert.equal(await count(table, column, a.owner.operatorId), 0, `${table} erased`);
    assert.ok((await count(table, column, b.owner.operatorId)) > 0, `${table} of B kept`);
  }
  // The anonymous table has no owner column; the report and the global totals are unchanged.
  const columns = (
    await f.db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name='elric_cost_erased'",
    )
  ).rows.map((r) => r.column_name);
  assert.deepEqual(columns.sort(), ['cost_units', 'day_index', 'tier', 'turns']);
  assert.deepEqual(await report(), reportBefore);
  assert.deepEqual(
    (await f.db.query('SELECT * FROM elric_global_usage ORDER BY day')).rows,
    globalBefore,
  );
  // Idempotent.
  assert.equal((await eraseElricOwner(f.db, a.owner.operatorId)).turns, 0);
  assert.deepEqual(await report(), reportBefore);
});

test('elric_turns stays append-only outside the erase function', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Room C');
  f.small.push({ text: 'An answer.' });
  await f.say(s.owner, s.room, '@Elric hi', s.person);
  await f.elric.drain();
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
  await assert.rejects(f.db.query("UPDATE elric_turns SET reason='x'"), /append-only/);
  await assert.rejects(f.db.query('TRUNCATE elric_turns'), /append-only/);
  // The setting for one owner never unlocks another owner's rows.
  await assert.rejects(
    f.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('elric.erase_owner', 'someone-else', true)");
      await tx.query('DELETE FROM elric_turns');
    }),
    /append-only/,
  );
  // After a transaction, the setting is gone.
  await f.db.transaction(async (tx) => {
    await tx.query("SELECT set_config('elric.erase_owner', $1, true)", [s.owner.operatorId]);
  });
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
});

test('eraseElricOwner: hard-deletes the private Elric chat room and its messages', async (t) => {
  const f = await elricFixture(t);
  const chatFor = async (name: string) => {
    const owner = await f.account(name);
    await f.verify(owner);
    const added = await f.call(owner.cookie, 'POST', '/api/elric', {});
    assert.ok(added.statusCode < 300, added.body);
    const chat = await f.call(owner.cookie, 'GET', '/api/elric/chat');
    assert.equal(chat.statusCode, 200, chat.body);
    const roomId = chat.json().room_id as string;
    const list = (await f.call(owner.cookie, 'GET', `/api/rooms/${roomId}/members`)).json()
      .members as Array<{ id: string; kind: string; own: boolean }>;
    const person = list.find((m) => m.own && m.kind === 'person')!;
    const posted = await f.call(owner.cookie, 'POST', `/api/rooms/${roomId}/messages`, {
      text: 'a private note to Elric',
      agent_id: person.id,
      idempotency_key: randomUUID(),
    });
    assert.equal(posted.statusCode, 201, posted.body);
    return { owner, roomId };
  };
  const a = await chatFor('Erase A');
  // A normal room the same owner hosts survives the erase, with its messages.
  const desk = await f.agent(a.owner, 'Owner desk');
  const hosted = await f.room(a.owner, desk, 'Owner public room');
  const hostedPost = await f.call(a.owner.cookie, 'POST', `/api/rooms/${hosted.id}/messages`, {
    text: 'a normal room message',
    agent_id: desk,
    idempotency_key: randomUUID(),
  });
  assert.equal(hostedPost.statusCode, 201, hostedPost.body);
  const b = await chatFor('Erase B');
  const rows = async (table: string, roomId: string) =>
    Number(
      (
        await f.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${table === 'rooms' ? 'id' : 'room_id'}=$1`,
          [roomId],
        )
      ).rows[0].n,
    );
  assert.ok((await rows('room_messages', a.roomId)) > 0);

  const result = await eraseElricOwner(f.db, a.owner.operatorId);
  assert.equal(result.private_rooms, 1);
  const withRoomId = (
    await f.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name='room_id'`,
    )
  ).rows.map((r) => r.table_name);
  for (const table of [...withRoomId, 'rooms'])
    assert.equal(await rows(table, a.roomId), 0, `${table} of the erased private room`);
  const leftover = await f.db.query(
    "SELECT 1 FROM room_messages WHERE parts::text LIKE '%a private note%' AND room_id=$1",
    [a.roomId],
  );
  assert.equal(leftover.rows.length, 0);
  assert.equal(await rows('rooms', hosted.id), 1, 'the hosted normal room survives');
  assert.ok((await rows('room_messages', hosted.id)) > 0, 'its messages survive');
  assert.ok((await rows('room_members', hosted.id)) > 0, 'its members survive');
  // The other owner's private room is untouched.
  assert.equal(await rows('rooms', b.roomId), 1);
  assert.ok((await rows('room_messages', b.roomId)) > 0);
  // Idempotent.
  assert.equal((await eraseElricOwner(f.db, a.owner.operatorId)).private_rooms, 0);
});
