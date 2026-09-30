import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import {
  TASK_LAPSE_BATCH,
  TASK_LAPSE_MAX_BATCHES,
  WAKE_DRAIN_PATH,
  registerWakeCron,
  sweepTaskLapses,
} from '../server/wake/cron.js';

/**
 * The scheduled drain also clears lapsed room-task claims (docs/ROOM_TASKS.md): reads lapse a
 * claim lazily, but in a room nobody reads a lapsed claim would stay "claimed" forever. The sweep
 * runs beside the wake drain under one deadline, in bounded batches, idempotently, and an error in
 * it never changes the drain's answer. Synthetic data only.
 */
const SECRET = 'a-sufficiently-long-cron-secret';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

test('sweepTaskLapses: bounded batches, stops at a short batch or the deadline, contains errors', async () => {
  const sizes: number[] = [];
  const batches = (counts: number[]) => {
    let i = 0;
    return async (limit: number) => {
      sizes.push(limit);
      const n = counts[i++] ?? 0;
      return { lapsed: Array.from({ length: n }) };
    };
  };
  // Full, full, short: three batches, then stop.
  assert.deepEqual(
    await sweepTaskLapses(batches([TASK_LAPSE_BATCH, TASK_LAPSE_BATCH, 7]), Date.now() + 60_000),
    { lapsed: 2 * TASK_LAPSE_BATCH + 7, error: false },
  );
  assert.ok(sizes.every((size) => size === TASK_LAPSE_BATCH));
  // Never more than the batch cap, even if every batch is full.
  let calls = 0;
  const full = async () => {
    calls++;
    return { lapsed: Array.from({ length: TASK_LAPSE_BATCH }) };
  };
  const capped = await sweepTaskLapses(full, Date.now() + 60_000);
  assert.equal(calls, TASK_LAPSE_MAX_BATCHES);
  assert.equal(capped.lapsed, TASK_LAPSE_MAX_BATCHES * TASK_LAPSE_BATCH);
  // Past the deadline nothing starts.
  calls = 0;
  assert.deepEqual(await sweepTaskLapses(full, Date.now() - 1), { lapsed: 0, error: false });
  assert.equal(calls, 0);
  // A failure keeps what was done and reports the error instead of throwing.
  let step = 0;
  const flaky = async () => {
    if (step++ === 1) throw new Error('database unavailable');
    return { lapsed: Array.from({ length: TASK_LAPSE_BATCH }) };
  };
  assert.deepEqual(await sweepTaskLapses(flaky, Date.now() + 60_000), {
    lapsed: TASK_LAPSE_BATCH,
    error: true,
  });
});

test('the cron route sweeps beside the drain; a failing sweep never changes the drain answer', async (t) => {
  const lines: string[] = [];
  let sweeps = 0;
  let drains = 0;
  const wake = {
    drainNow: async () => {
      drains++;
      return { webhooks: 1, responder: null };
    },
  };
  const app = Fastify();
  registerWakeCron(app, {
    wake,
    cronSecret: SECRET,
    sweepTasks: async () => {
      sweeps++;
      throw new Error('sweep failed');
    },
    log: (line) => lines.push(line),
  });
  t.after(() => app.close());
  const refused = await app.inject({
    url: WAKE_DRAIN_PATH,
    headers: { authorization: 'Bearer x' },
  });
  assert.equal(refused.statusCode, 404);
  assert.equal(sweeps, 0, 'no sweep without the cron secret');
  const ok = await app.inject({
    url: WAKE_DRAIN_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { webhooks: 1, responder: null });
  assert.equal(drains, 1);
  assert.equal(sweeps, 1);
  assert.deepEqual(lines, ['room_tasks.lapse_sweep lapsed=0 error=true']);
});

test('a lapsed claim in a room nobody reads is cleared by the scheduled drain, once', async (t) => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Lapse host', password: 'Synthetic lapse password' }),
  });
  const cookie = `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const operatorId = (await app.inject({ url: '/api/session', headers: { cookie } })).json()
    .operator.id as string;
  const agentId = (
    await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify({ name: 'Lapse desk', capability: 'research', mode: 'hosted' }),
    })
  ).json().agent.id as string;
  const created = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({
      agent_id: agentId,
      name: 'Quiet room',
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const tasks = createRoomTasks({
    db: app.city.db,
    clock: Date.now,
    limit: async () => {},
    secret: 'test-rooms-secret',
  });
  const p = { operatorId, actor: 'the test owner', origin: 'http://localhost' };
  const task = (await tasks.create(p, {
    room_id: roomId,
    title: 'Left behind',
    idempotency_key: randomUUID(),
  })) as { task: { id: string } };
  await tasks.claim(p, { room_id: roomId, task_id: task.task.id, idempotency_key: randomUUID() });
  const status = async () =>
    (
      await app.city.db.query<{ status: string; claim_agent_id: string | null }>(
        'SELECT status,claim_agent_id FROM room_tasks WHERE id=$1',
        [task.task.id],
      )
    ).rows[0]!;
  const drain = () =>
    app.inject({ url: WAKE_DRAIN_PATH, headers: { authorization: `Bearer ${SECRET}` } });

  // Still within its lease: the drain leaves it alone.
  assert.equal((await drain()).statusCode, 200);
  assert.equal((await status()).status, 'claimed');
  // The lease and grace are over, and nobody reads the room.
  await app.city.db.query(
    `UPDATE room_tasks SET claim_expires_at = (EXTRACT(EPOCH FROM now())*1000)::bigint - claim_grace_ms - 60000
      WHERE id=$1`,
    [task.task.id],
  );
  assert.equal((await drain()).statusCode, 200);
  assert.deepEqual(await status(), { status: 'open', claim_agent_id: null });
  // Idempotent: the next run finds nothing more, and exactly one lapse was recorded.
  assert.equal((await drain()).statusCode, 200);
  const events = (
    await app.city.db.query<{ action: string }>(
      "SELECT action FROM room_task_events WHERE task_id=$1 AND action='lapsed'",
      [task.task.id],
    )
  ).rows;
  assert.equal(events.length, 1);
});
