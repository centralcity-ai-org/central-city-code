import test from 'node:test';
import assert from 'node:assert/strict';
import { PENDING_EXECUTION_GRACE_MS, PendingActionError } from '../server/elric/pending.js';
import { argsHash } from '../server/elric/turns.js';
import { elricPendingToolText } from '../server/elric/service.js';
import { elricMockModels } from '../server/elric/endpoints.js';
import { elricFixture } from './elric-fixture.js';

/**
 * The owner-approval gate (docs/ELRIC.md, pending actions): a consequential tool call
 * (room_task_create) never runs from model output. It becomes a pending action with the exact
 * validated arguments, the turn is 'pending', and only the owner's console session can approve
 * it, naming the hash it was shown; approval runs the STORED arguments once, under the same
 * rechecks. Synthetic names only.
 */
async function pendingScene(t: Parameters<typeof elricFixture>[0]) {
  const f = await elricFixture(t);
  const s = await f.scene('Approval room');
  const trigger = await f.say(
    s.owner,
    s.room,
    '@Elric create a task for the release notes',
    s.person,
  );
  f.large.push(
    {
      toolCalls: [
        {
          name: 'room_task_create',
          args: { room_id: s.room.id, title: 'Release notes', body: 'Draft them.' },
        },
      ],
    },
    { text: 'I asked for your approval to create the task.' },
  );
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  const actions = (
    await f.db.query<{
      id: string;
      tool: string;
      args: Record<string, unknown>;
      args_hash: string;
      status: string;
      expires_at: string;
      created_at: string;
      owner_id: string;
      agent_id: string;
      room_id: string;
    }>('SELECT * FROM elric_pending_actions ORDER BY created_at')
  ).rows;
  const tasks = async () =>
    (await f.db.query<{ title: string; body: string | null }>('SELECT title, body FROM room_tasks'))
      .rows;
  return { f, s, result, actions, tasks };
}

test('a consequential call becomes one pending action; nothing is created; the turn is pending', async (t) => {
  const { f, s, result, actions, tasks } = await pendingScene(t);
  assert.equal(result?.outcome, 'pending', JSON.stringify(result));
  assert.equal(actions.length, 1);
  const [action] = actions;
  assert.equal(action!.tool, 'room_task_create');
  assert.deepEqual(action!.args, {
    room_id: s.room.id,
    title: 'Release notes',
    body: 'Draft them.',
  });
  assert.equal(action!.args_hash, argsHash(action!.args));
  assert.equal(action!.status, 'pending');
  assert.equal(
    Number(action!.expires_at) - Number(action!.created_at),
    f.elric.config.pendingActionTtlMs,
  );
  assert.deepEqual(
    [action!.owner_id, action!.agent_id, action!.room_id],
    [s.owner.operatorId, s.elricId, s.room.id],
  );
  assert.deepEqual(await tasks(), []);
  // The model got the fixed text with the pending id, and nothing else from the server.
  const toolMessage = f.large.requests.at(-1)!.messages.find((m) => m.role === 'tool');
  assert.ok(toolMessage && toolMessage.role === 'tool');
  assert.deepEqual(JSON.parse(toolMessage.content), {
    status: 'pending_approval',
    pending_id: action!.id,
    text: elricPendingToolText(action!.id),
  });
  const [turn] = await f.turns(s.owner.operatorId);
  assert.equal(turn!.outcome, 'pending');
  assert.deepEqual(
    turn!.tool_calls.map((call) => [call.name, call.status]),
    [['room_task_create', 'refused_pending']],
  );
});

test('only the owner session approves, with the shown hash, exactly once; stored args run', async (t) => {
  const { f, s, actions, tasks } = await pendingScene(t);
  const [action] = actions;
  // Never the model, an agent, a grant or a guest.
  for (const principal of [
    { kind: 'model' as const },
    { kind: 'agent' as const, operatorId: s.owner.operatorId, agentId: s.elricId },
    { kind: 'grant' as const, operatorId: s.owner.operatorId, grantId: 'g1' },
    { kind: 'guest' as const },
  ])
    await assert.rejects(
      f.elric.approve(principal, action!.id, action!.args_hash),
      (error) => (error as PendingActionError).errorCode === 'owner_session_required',
    );
  // Another owner's session: not found (never revealed).
  const other = await f.account('Other approver');
  const foreign = await f.call(other.cookie, 'POST', `/api/elric/pending/${action!.id}/approve`, {
    args_hash: action!.args_hash,
  });
  assert.equal(foreign.statusCode, 404, foreign.body);
  // The wrong hash is refused.
  const wrong = await f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action!.id}/approve`, {
    args_hash: '0'.repeat(64),
  });
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.deepEqual(await tasks(), []);
  // The owner approves what was shown: the stored arguments run, once.
  const approve = () =>
    f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action!.id}/approve`, {
      args_hash: action!.args_hash,
    });
  const ok = await approve();
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(await tasks(), [{ title: 'Release notes', body: 'Draft them.' }]);
  const again = await approve();
  assert.equal(again.statusCode, 409, again.body);
  assert.equal((await tasks()).length, 1);
  const row = (
    await f.db.query<{ status: string; result: unknown }>(
      'SELECT status, result FROM elric_pending_actions WHERE id=$1',
      [action!.id],
    )
  ).rows[0]!;
  assert.deepEqual(row, { status: 'approved', result: { task: 'T1' } });
});

test('approval rechecks Elric: paused executes nothing; tasks off at approval fails the action', async (t) => {
  const { f, s, actions, tasks } = await pendingScene(t);
  const [action] = actions;
  const approve = () =>
    f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action!.id}/approve`, {
      args_hash: action!.args_hash,
    });
  await f.call(s.owner.cookie, 'POST', '/api/elric/pause', {});
  const paused = await approve();
  assert.equal(paused.statusCode, 409, paused.body);
  assert.deepEqual(await tasks(), []);
  assert.equal(
    (await f.db.query<{ status: string }>('SELECT status FROM elric_pending_actions')).rows[0]!
      .status,
    'pending',
    'still pending: the owner may resume and approve',
  );
  await f.call(s.owner.cookie, 'POST', '/api/elric/resume', {});
  process.env.CITY_ROOM_TASKS = '0';
  try {
    const off = await approve();
    assert.equal(off.statusCode, 409, off.body);
  } finally {
    process.env.CITY_ROOM_TASKS = '1';
  }
  assert.deepEqual(await tasks(), []);
  assert.equal(
    (await f.db.query<{ status: string }>('SELECT status FROM elric_pending_actions')).rows[0]!
      .status,
    'failed',
  );
});

test('an expired pending action cannot be approved', async (t) => {
  const { f, s, actions, tasks } = await pendingScene(t);
  const [action] = actions;
  await f.db.query('UPDATE elric_pending_actions SET expires_at=1 WHERE id=$1', [action!.id]);
  const res = await f.call(s.owner.cookie, 'POST', `/api/elric/pending/${action!.id}/approve`, {
    args_hash: action!.args_hash,
  });
  assert.equal(res.statusCode, 409, res.body);
  assert.deepEqual(await tasks(), []);
  assert.equal(
    (await f.db.query<{ status: string }>('SELECT status FROM elric_pending_actions')).rows[0]!
      .status,
    'expired',
  );
});

test('CITY_ELRIC_MOCK model (end-to-end runs): "create a task: <title>" asks for the task in this room', async (t) => {
  const f = await elricFixture(t, { models: elricMockModels({ CITY_ELRIC_MOCK: '1' })! });
  const s = await f.scene('Mock room');
  const trigger = await f.say(
    s.owner,
    s.room,
    '@Elric create a task: Write the changelog',
    s.person,
  );
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'pending', JSON.stringify(result));
  const actions = (
    await f.db.query<{ args: Record<string, unknown> }>('SELECT args FROM elric_pending_actions')
  ).rows;
  assert.deepEqual(
    actions.map((row) => row.args),
    [{ room_id: s.room.id, title: 'Write the changelog' }],
  );
  assert.equal(f.textOf((await f.messages(s.room.id)).at(-1)!), 'Waiting for your approval.');
  // Anything else: a plain "Mock reply." and no tool call.
  const plain = await f.say(s.owner, s.room, '@Elric how are things?', s.person);
  const second = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: plain.message.seq,
  });
  assert.equal(second?.outcome, 'ok');
  assert.equal(f.textOf((await f.messages(s.room.id)).at(-1)!), 'Mock reply.');
  assert.equal((await f.db.query('SELECT 1 FROM elric_pending_actions')).rows.length, 1);
});

test('one run creates at most maxPendingPerRun pending actions; the rest are refused', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Cap room');
  const trigger = await f.say(s.owner, s.room, '@Elric create a task for each item', s.person);
  const call = (n: number) => ({
    name: 'room_task_create',
    args: { room_id: s.room.id, title: `Item ${n}` },
  });
  f.large.push(
    { toolCalls: [call(1), call(2), call(3), call(4)] },
    { toolCalls: [call(5), call(6)] },
    { text: 'Asked for approval.' },
  );
  await f.elric.run({ agentId: s.elricId, roomId: s.room.id, sourceSeq: trigger.message.seq });
  const max = f.elric.config.maxPendingPerRun;
  assert.equal((await f.db.query('SELECT 1 FROM elric_pending_actions')).rows.length, max);
  const [turn] = await f.turns(s.owner.operatorId);
  assert.deepEqual(
    turn!.tool_calls.map((item) => item.status),
    [...Array(max).fill('refused_pending'), ...Array(6 - max).fill('refused_cap')],
  );
});

test('an approved action whose execution never reported a result is swept to failed', async (t) => {
  const { f, s, actions } = await pendingScene(t);
  const [action] = actions;
  // The process stopped between the claim and the task creation.
  await f.db.query(
    "UPDATE elric_pending_actions SET status='approved', decided_at=$2, result=NULL WHERE id=$1",
    [action!.id, f.now() - PENDING_EXECUTION_GRACE_MS - 1],
  );
  await f.elric.drain();
  const row = (
    await f.db.query<{ status: string; result: unknown }>(
      'SELECT status, result FROM elric_pending_actions WHERE id=$1',
      [action!.id],
    )
  ).rows[0]!;
  assert.deepEqual(row, { status: 'failed', result: { error: 'execution_unconfirmed' } });
  assert.equal((await f.db.query('SELECT 1 FROM room_tasks')).rows.length, 0, 'never re-executed');
  // A fresh approval inside the grace period is left alone.
  await f.db.query(
    "UPDATE elric_pending_actions SET status='approved', decided_at=$2, result=NULL WHERE id=$1",
    [action!.id, f.now()],
  );
  await f.elric.drain();
  assert.equal(
    (
      await f.db.query<{ status: string }>('SELECT status FROM elric_pending_actions WHERE id=$1', [
        action!.id,
      ])
    ).rows[0]!.status,
    'approved',
  );
  void s;
});
