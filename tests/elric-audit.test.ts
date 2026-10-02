import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvePendingAction,
  createPendingAction,
  PendingActionError,
  rejectPendingAction,
  type ElricPrincipal,
  type PendingAction,
} from '../server/elric/pending.js';
import { argsHash, listElricTurns, recordTurn } from '../server/elric/turns.js';
import { elricFixture } from './elric-fixture.js';

/** The append-only, owner-queryable turn log, and server-side pending actions. */

test('turn log: append-only, owner-only, paginated past 1,000 rows', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.account('Other owner');
  for (let i = 0; i < 1_050; i++)
    await recordTurn(
      f.db,
      {
        ownerId: s.owner.operatorId,
        agentId: s.elricId,
        roomId: s.room.id,
        invokerMemberId: s.person,
        invokerKind: 'owner',
        sourceSeq: i + 1,
        outcome: 'ok',
      },
      f.now() + i,
    );
  const seen = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listElricTurns(f.db, s.owner.operatorId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const turn of page.turns) seen.add(turn.id);
    cursor = page.next_cursor ?? undefined;
    pages++;
  } while (cursor);
  assert.equal(seen.size, 1_050);
  assert.equal(pages, 11);
  // Newest first; another owner sees none of them, over the route too.
  const first = await f.call(s.owner.cookie, 'GET', '/api/elric/turns?limit=2');
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().turns[0].source_seq, 1_050);
  assert.ok(first.json().next_cursor);
  const foreign = await f.call(other.cookie, 'GET', '/api/elric/turns');
  assert.deepEqual(foreign.json(), { turns: [], next_cursor: null });
  // Append-only: no update, delete or truncate.
  await assert.rejects(f.db.query("UPDATE elric_turns SET outcome='error'"), /append-only/);
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
  await assert.rejects(f.db.query('TRUNCATE elric_turns'), /append-only/);
});

test('pending actions: only the owner session approves, and approval runs the STORED arguments', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const other = await f.account('Other approver');
  const stored = { room_id: s.room.id, reason: 'spring cleaning' };
  const action = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_close',
      args: stored,
    },
    f.now(),
    60_000,
  );
  assert.equal(action.args_hash, argsHash(stored));
  const executed: PendingAction[] = [];
  const executors = {
    room_close: async (item: PendingAction) => {
      executed.push(item);
      return { closed: item.args.room_id };
    },
  };
  const approve = (principal: ElricPrincipal, hash = action.args_hash) =>
    approvePendingAction(f.db, principal, { id: action.id, argsHash: hash }, executors, f.now());
  const code = (error: unknown) => (error as PendingActionError).errorCode;

  // The model, a guest, an agent and a grant can never approve.
  for (const principal of [
    { kind: 'model' },
    { kind: 'guest' },
    { kind: 'agent', operatorId: s.owner.operatorId, agentId: s.elricId },
    { kind: 'grant', operatorId: s.owner.operatorId, grantId: 'grant-1' },
  ] as ElricPrincipal[])
    await assert.rejects(approve(principal), (error) => code(error) === 'owner_session_required');
  // Another owner's session: the uniform not_found.
  await assert.rejects(
    approve({ kind: 'owner_session', operatorId: other.operatorId }),
    (error) => code(error) === 'not_found',
  );
  // The owner must approve exactly what was shown.
  const owner: ElricPrincipal = { kind: 'owner_session', operatorId: s.owner.operatorId };
  await assert.rejects(
    approve(owner, argsHash({ ...stored, room_id: 'elsewhere' })),
    (error) => code(error) === 'hash_mismatch',
  );
  // Tampering with the stored row after creation breaks the hash too.
  await f.db.query(
    `UPDATE elric_pending_actions SET args=jsonb_set(args,'{room_id}','"elsewhere"') WHERE id=$1`,
    [action.id],
  );
  await assert.rejects(approve(owner), (error) => code(error) === 'hash_mismatch');
  await f.db.query('UPDATE elric_pending_actions SET args=$2::jsonb WHERE id=$1', [
    action.id,
    JSON.stringify(stored),
  ]);
  assert.equal(executed.length, 0);
  const done = await approve(owner);
  assert.deepEqual(done.result, { closed: s.room.id });
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0]!.args, stored, 'the stored arguments ran, nothing else');
  await assert.rejects(approve(owner), (error) => code(error) === 'not_pending');

  // Expiry, rejection, and the console route (other owner: 404; model output never reaches it).
  const late = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_close',
      args: stored,
    },
    f.now() - 120_000,
    60_000,
  );
  await assert.rejects(
    approvePendingAction(
      f.db,
      owner,
      { id: late.id, argsHash: late.args_hash },
      executors,
      f.now(),
    ),
    (error) => code(error) === 'expired',
  );
  const rejected = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_close',
      args: stored,
    },
    f.now(),
    60_000,
  );
  await assert.rejects(
    rejectPendingAction(f.db, { kind: 'model' }, rejected.id, f.now()),
    (error) => code(error) === 'owner_session_required',
  );
  await rejectPendingAction(f.db, owner, rejected.id, f.now());
  const viaRoute = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_close',
      args: stored,
    },
    f.now(),
    60_000,
  );
  const foreign = await f.call(other.cookie, 'POST', `/api/elric/pending/${viaRoute.id}/approve`, {
    args_hash: viaRoute.args_hash,
  });
  assert.equal(foreign.statusCode, 404);
  // The slice registers no executor: even the owner's approval runs nothing.
  const own = await f.call(s.owner.cookie, 'POST', `/api/elric/pending/${viaRoute.id}/approve`, {
    args_hash: viaRoute.args_hash,
  });
  assert.equal(own.statusCode, 409);
  assert.equal(own.json().code, 'no_executor');
  assert.equal(executed.length, 1);
});

test('no message content in the turn log, Elric tables or server logs', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const sentinel = 'SENTINEL-7b3e-content';
  const logged: string[] = [];
  const originals = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const level of ['log', 'info', 'warn', 'error'] as const)
    console[level] = (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    };
  try {
    await f.say(s.host, s.room, `note: ${sentinel}`, s.hostAgent);
    const guest = await f.account('Guest account');
    const guestPerson = await f.joinPerson(guest, s.room, 'Sentry');
    await f.say(guest, s.room, `@Elric ${sentinel}`, guestPerson);
    const trigger = await f.say(s.owner, s.room, `@Elric repeat ${sentinel}`, s.person);
    f.small.push(
      { toolCalls: [{ name: 'room_read', args: { room_id: s.room.id, note: sentinel } }] },
      { text: `It says ${sentinel} [#1].` },
    );
    await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  } finally {
    Object.assign(console, originals);
  }
  assert.match(JSON.stringify(f.received()), new RegExp(sentinel), 'the model did see it');
  for (const table of [
    'elric_turns',
    'elric_invocations',
    'elric_posts',
    'elric_notices',
    'elric_usage',
    'elric_global_usage',
  ]) {
    const rows = (await f.db.query(`SELECT * FROM ${table}`)).rows;
    assert.doesNotMatch(JSON.stringify(rows), new RegExp(sentinel), table);
  }
  assert.ok((await f.turns(s.owner.operatorId)).length >= 2);
  assert.doesNotMatch(logged.join('\n'), new RegExp(sentinel));
});

test('pending approval rechecks Elric under the lock: a paused Elric executes nothing', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const stored = { room_id: s.room.id };
  const action = await createPendingAction(
    f.db,
    {
      ownerId: s.owner.operatorId,
      agentId: s.elricId,
      roomId: s.room.id,
      tool: 'room_close',
      args: stored,
    },
    f.now(),
    60_000,
  );
  let ran = 0;
  const executors = {
    room_close: async () => {
      ran++;
      return null;
    },
  };
  const owner: ElricPrincipal = { kind: 'owner_session', operatorId: s.owner.operatorId };
  await f.elric.pause(s.owner.operatorId);
  await assert.rejects(
    approvePendingAction(
      f.db,
      owner,
      { id: action.id, argsHash: action.args_hash },
      executors,
      f.now(),
    ),
    (error) => (error as PendingActionError).errorCode === 'elric_unavailable',
  );
  assert.equal(ran, 0);
  await f.elric.resume(s.owner.operatorId);
  await approvePendingAction(
    f.db,
    owner,
    { id: action.id, argsHash: action.args_hash },
    executors,
    f.now(),
  );
  assert.equal(ran, 1);
});
