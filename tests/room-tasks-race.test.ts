import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createRoomTasks } from '../server/rooms/tasks-service.js';
import { registerRoomTasksMigration } from '../server/rooms/tasks-schema.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';

registerRoomTasksMigration();

/**
 * Room tasks PR1 race tests (plan §4 A1 + renew-after-expiry +
 * pool test). Twenty concurrent claimants fight over one task through the single
 * conditional UPDATE: exactly one wins, the rest get `409 task_claimed`.
 *
 * Pool note: the hosted limiter is charged before each transaction (never inside), so no
 * transaction ever waits on a limiter client while holding a pool client. The storm test
 * below runs claim/renew/read traffic concurrently against the pool to prove nothing
 * deadlocks. On PGlite (`:memory:`) transactions serialize on one connection, which keeps
 * exactly-once true; this file also runs on the hosted-PostgreSQL path with a
 * three-client pool. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
let addressCounter = 101;

async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.20`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
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
    payload: JSON.stringify({ label: 'race tester', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return { id, key: minted.json().workspace_key as string };
}
async function tool(app: App, key: string, name: string, args: unknown = {}) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...jsonHeaders, authorization: `Bearer ${key}` },
    payload: JSON.stringify(args),
  });
  assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
  return res.json() as any;
}
/** A room with 20 racers in it: the host agent plus 19 joined members. */
async function twentyWayRoom(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  // A small limiter delay forces the racers to overlap before their transactions.
  const tasks = createRoomTasks({
    db: app.city.db,
    clock: () => Date.now(),
    limit: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
    secret: 'test-rooms-secret',
  });
  const host = await owner(app, 'Race host workspace');
  const hostAgent = (
    await tool(app, host.key, 'city_create_agent', {
      name: 'Race host',
      description: 'Synthetic race member',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const created = await tool(app, host.key, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Synthetic race desk',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const racers: { ownerId: string; agentId: string }[] = [{ ownerId: host.id, agentId: hostAgent }];
  for (let i = 0; i < 19; i++) {
    const member = await owner(app, `Race member workspace ${i}`);
    const agentId = (
      await tool(app, member.key, 'city_create_agent', {
        name: `Racer ${i}`,
        description: 'Synthetic race member',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      })
    ).agent.id as string;
    const joined = await app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_join_room',
      headers: { ...jsonHeaders, authorization: `Bearer ${member.key}` },
      payload: JSON.stringify({
        link: created.link.link,
        agent_id: agentId,
        idempotency_key: randomUUID(),
      }),
    });
    assert.equal(joined.statusCode, 200, joined.body);
    racers.push({ ownerId: member.id, agentId });
  }
  return { app, tasks, roomId, racers };
}
const p = (operatorId: string) => ({
  operatorId,
  actor: 'the test owner',
  origin: 'http://localhost',
});

test('A1: 20-way claim race — exactly one winner, one event, generation +1 once', async (t) => {
  const { app, tasks, roomId, racers } = await twentyWayRoom(t);
  const made = await tasks.create(p(racers[0]!.ownerId), {
    room_id: roomId,
    agent_id: racers[0]!.agentId,
    title: 'Raced task',
    idempotency_key: randomUUID(),
  });
  const taskId = made.task.id;
  const results = await Promise.allSettled(
    racers.map((racer) =>
      tasks.claim(p(racer.ownerId), {
        room_id: roomId,
        task_id: taskId,
        agent_id: racer.agentId,
        idempotency_key: randomUUID(),
      }),
    ),
  );
  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 19);
  const winner = (won[0] as PromiseFulfilledResult<any>).value;
  assert.match(winner.claim_token, /^ccclaim_/);
  assert.equal(winner.generation, 1);
  for (const loser of lost) {
    const err = (loser as PromiseRejectedResult).reason as { errorCode?: string; details?: any };
    assert.equal(err.errorCode, 'task_claimed');
    assert.equal(err.details.claimed_by, winner.task.claim.agent_id);
  }
  const row = (
    await app.city.db.query<{ claim_agent_id: string; claim_generation: string | number }>(
      'SELECT claim_agent_id,claim_generation FROM room_tasks WHERE id=$1',
      [taskId],
    )
  ).rows[0]!;
  assert.equal(row.claim_agent_id, winner.task.claim.agent_id);
  assert.equal(Number(row.claim_generation), 1);
  const events = (
    await app.city.db.query<{ action: string }>(
      "SELECT action FROM room_task_events WHERE task_id=$1 AND action='claimed'",
      [taskId],
    )
  ).rows;
  assert.equal(events.length, 1);
});

test('renew-after-expiry: inside grace renews, past grace is stale, takeover wins', async (t) => {
  const { app, tasks, roomId, racers } = await twentyWayRoom(t);
  const first = racers[0]!;
  const second = racers[1]!;
  const made = await tasks.create(p(first.ownerId), {
    room_id: roomId,
    agent_id: first.agentId,
    title: 'Lease task',
    idempotency_key: randomUUID(),
  });
  const claimed = await tasks.claim(p(first.ownerId), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: first.agentId,
    ttl_minutes: 5,
    idempotency_key: randomUUID(),
  });
  // Expired 30 s ago with a 10-min grace: the holder still renews.
  await app.city.db.query(
    'UPDATE room_tasks SET claim_expires_at=$2, claim_grace_ms=$3 WHERE id=$1',
    [made.task.id, Date.now() - 30_000, 600_000],
  );
  const renewed = await tasks.renew(p(first.ownerId), {
    room_id: roomId,
    task_id: made.task.id,
    claim_token: claimed.claim_token,
  });
  assert.ok(Date.parse(renewed.expires_at) > Date.now());
  // Past grace: renew is stale and changes nothing; a missed poll releases nothing early
  // for the holder — the lease simply lapses and the next claimant takes over.
  await app.city.db.query(
    'UPDATE room_tasks SET claim_expires_at=$2, claim_grace_ms=$3 WHERE id=$1',
    [made.task.id, Date.now() - 600_000, 60_000],
  );
  try {
    await tasks.renew(p(first.ownerId), {
      room_id: roomId,
      task_id: made.task.id,
      claim_token: claimed.claim_token,
    });
    assert.fail('expected claim_stale');
  } catch (error) {
    const err = error as { errorCode?: string; details?: any };
    assert.equal(err.errorCode, 'claim_stale');
    assert.equal(err.details.current_holder, first.agentId);
  }
  const taken = await tasks.claim(p(second.ownerId), {
    room_id: roomId,
    task_id: made.task.id,
    agent_id: second.agentId,
    idempotency_key: randomUUID(),
  });
  assert.equal(taken.task.claim?.agent_id, second.agentId);
  // The old token is dead for every claimant write.
  for (const run of [
    () =>
      tasks.renew(p(first.ownerId), {
        room_id: roomId,
        task_id: made.task.id,
        claim_token: claimed.claim_token,
      }),
    () =>
      tasks.release(p(first.ownerId), {
        room_id: roomId,
        task_id: made.task.id,
        claim_token: claimed.claim_token,
      }),
  ]) {
    try {
      await run();
      assert.fail('expected claim_stale');
    } catch (error) {
      const err = error as { errorCode?: string; details?: any };
      assert.equal(err.errorCode, 'claim_stale');
      assert.deepEqual(err.details, {
        current_holder: second.agentId,
        generation: taken.generation,
      });
    }
  }
  // …while the new holder's rows are untouched.
  const seen = await tasks.get(p(second.ownerId), { room_id: roomId, task_id: made.task.id });
  assert.equal(seen.task.claim?.agent_id, second.agentId);
  assert.equal(seen.task.claim?.generation, taken.generation);
});

test('pool storm: mixed claim/renew/read traffic settles with no deadlock', async (t) => {
  const { tasks, roomId, racers } = await twentyWayRoom(t);
  const made = await tasks.create(p(racers[0]!.ownerId), {
    room_id: roomId,
    agent_id: racers[0]!.agentId,
    title: 'Storm task',
    idempotency_key: randomUUID(),
  });
  const taskId = made.task.id;
  const winner = await tasks.claim(p(racers[0]!.ownerId), {
    room_id: roomId,
    task_id: taskId,
    agent_id: racers[0]!.agentId,
    idempotency_key: randomUUID(),
  });
  const storm = await Promise.allSettled(
    racers.flatMap((racer, i) => [
      tasks.get(p(racer.ownerId), { room_id: roomId, task_id: taskId }),
      tasks.list(p(racer.ownerId), { room_id: roomId }),
      tasks.events(p(racer.ownerId), { room_id: roomId, task_id: taskId }),
      tasks.renew(p(racer.ownerId), {
        room_id: roomId,
        task_id: taskId,
        claim_token: i === 0 ? winner.claim_token : 'ccclaim_stormtoken0000000000000001',
      }),
    ]),
  );
  const okCount = storm.filter((r) => r.status === 'fulfilled').length;
  // 20 gets + 20 lists + 20 event reads + 1 holder renew succeed; 19 foreign renews go stale.
  assert.equal(okCount, 61);
  for (const [index, result] of storm.entries()) {
    if (result.status === 'rejected' && index % 4 === 3 && index !== 3) {
      assert.equal((result.reason as { errorCode?: string }).errorCode, 'claim_stale');
    } else if (result.status === 'rejected') {
      assert.fail(`unexpected rejection at ${index}: ${String(result.reason)}`);
    }
  }
});
