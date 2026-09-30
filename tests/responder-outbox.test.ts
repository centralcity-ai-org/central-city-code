import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { createOutbox, type Claimed } from '../server/wake/webhooks.js';
import { outageMode } from '../server/rate-limit.js';

/**
 * Wake outbox per kind: the kind filter sits in the claim subquery,
 * disabled targets never fill the window, and handler kinds are never dropped by attempts.
 */
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const operator = randomUUID();
  await db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,'Outbox owner',$2,'x','y')",
    [operator, `outbox-${operator}`],
  );
  const target = async (kind: 'https' | 'responder', disabled = false) => {
    const id = randomUUID();
    const agent = randomUUID();
    await db.query(
      `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by,kind,disabled_at)
       VALUES($1,$2,$3,$4,ARRAY['mention'],'s',1,'test',$5,$6)`,
      [
        id,
        agent,
        operator,
        kind === 'https' ? 'https://example.com/hook' : null,
        kind,
        disabled ? 1 : null,
      ],
    );
    await db.query(
      `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
       VALUES($1,$2,ARRAY['mention'],'{}'::jsonb,1,1,0,1,1,$3)`,
      [id, agent, kind],
    );
    return { id, agent };
  };
  return { db, target };
}

test("one kind never fills the other kind's claim window; disabled targets are skipped (B1, B2)", async (t) => {
  const { db, target } = await fixture(t);
  for (let index = 0; index < 25; index++) await target('https');
  for (let index = 0; index < 25; index++) await target('responder', true);
  const live = await target('responder');
  const seen: Claimed[] = [];
  const outbox = createOutbox({
    db,
    clock: () => 10,
    keys: [],
    transport: async () => ({ status: 200 }),
    kind: 'responder',
    claimLimit: 5,
    handler: async (row) => {
      seen.push(row);
      return { outcome: 'done' };
    },
  });
  await outbox.drain();
  assert.deepEqual(
    seen.map((row) => row.webhook_id),
    [live.id],
  );
  const left = await db.query<{ kind: string; n: string }>(
    'SELECT kind, count(*) AS n FROM wake_outbox GROUP BY kind ORDER BY kind',
  );
  assert.deepEqual(
    left.rows.map((row) => [row.kind, Number(row.n)]),
    [
      ['https', 25],
      ['responder', 25],
    ],
    'https rows untouched; the live responder row delivered',
  );
});

test("a handler kind is never dropped by attempts; it retries at the handler's time (B3)", async (t) => {
  const { db, target } = await fixture(t);
  const live = await target('responder');
  let clock = 10;
  let calls = 0;
  const outbox = createOutbox({
    db,
    clock: () => clock,
    keys: [],
    transport: async () => ({ status: 200 }),
    kind: 'responder',
    maxAttempts: 2,
    handler: async () => {
      calls++;
      return { outcome: 'retry', at: clock + 1000 };
    },
  });
  for (let round = 0; round < 6; round++) {
    await outbox.drain();
    clock += 2000;
  }
  assert.equal(calls, 6);
  const row = (
    await db.query<{ next_attempt_at: string; attempts: number }>(
      'SELECT next_attempt_at, attempts FROM wake_outbox WHERE webhook_id=$1',
      [live.id],
    )
  ).rows[0];
  assert.ok(row, 'still queued after more than maxAttempts');
  // A paused outcome removes it.
  const paused = createOutbox({
    db,
    clock: () => clock,
    keys: [],
    transport: async () => ({ status: 200 }),
    kind: 'responder',
    handler: async () => ({ outcome: 'paused' }),
  });
  await paused.drain();
  assert.equal((await db.query('SELECT 1 FROM wake_outbox')).rows.length, 0);
});

test('responder limiter buckets fail closed', () => {
  for (const key of [
    'responder-key:x',
    'responder-room:x',
    'responder-agent-room:x:y',
    'responder-pair:x:y',
    'responder-pair-day:x:y',
    'responder-unclaimed-day:x',
  ])
    assert.equal(outageMode(key), 'fail-closed', key);
});
