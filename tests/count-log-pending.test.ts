import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { generateSigningKey } from '../server/manifest/keys.js';
import { createCountLog, registerCountLogMigration } from '../server/count-log/index.js';
import { LIVE_LOG_MINUTE } from '../server/count-log/pending.js';
import { agentLeafHash, toHex } from '../shared/count-log/index.js';

/**
 * Live log Phase 2: new agents appear in a public pending feed as they are created (fingerprint,
 * day and minute), and the next checkpoint confirms exactly that fingerprint. Synthetic data.
 */
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof createApp>>;

async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name, password: 'Synthetic pending feed password' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((c) => c.name === 'cc_session')!.value}`;
  return { cookie, id: res.json().operator.id as string };
}
async function agent(app: App, cookie: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/agents',
    headers: { ...headers, cookie },
    payload: JSON.stringify({ name, description: 'x', capability: 'research', mode: 'external' }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json().agent.id as string;
}
function nextCheckpointAt(now: number): number {
  const next = new Date(now);
  next.setUTCHours(0, 10, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}
/** A second log on the same database whose clock is a day ahead (the next day's checkpoint). */
function createCountLogNextDay(app: App) {
  const at = Date.now() + 86_400_000;
  return createCountLog({
    db: app.city.db,
    clock: () => at,
    signingKey: generateSigningKey('next'),
  });
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  // The checkpoint runs the day after today (real time), so it includes today's agents.
  let now = Date.now() + 86_400_000;
  const log = createCountLog({
    db: app.city.db,
    clock: () => now,
    signingKey: generateSigningKey('pending-test'),
  });
  const feed = (query = '') =>
    app.inject({ method: 'GET', url: `/api/public/count-log/feed${query}` });
  return { app, log, feed, nextDay: () => (now += 86_400_000) };
}

test('a new agent appears pending at once: fingerprint, day and minute; nothing personal', async (t) => {
  const { app, feed } = await fixture(t);
  const alice = await owner(app, 'Pending Alice');
  const id = await agent(app, alice.cookie, 'Pending Alpha Bot');
  const res = await feed();
  assert.equal(res.statusCode, 200);
  assert.equal(
    res.headers['cache-control'],
    'public, max-age=2, s-maxage=2, stale-while-revalidate=5',
  );
  const body = res.json();
  assert.equal(body.entries.length, 1);
  const [entry] = body.entries;
  assert.match(entry.fingerprint, /^[0-9a-f]{64}$/);
  assert.match(entry.day, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(LIVE_LOG_MINUTE, true);
  assert.match(entry.minute, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/);
  assert.ok(entry.minute.startsWith(entry.day));
  assert.equal(entry.status, 'pending');
  for (const secret of [id, alice.id, 'Pending Alice', 'Pending Alpha Bot', 'person', 'kind'])
    assert.ok(!res.body.includes(secret), secret);
  // The fingerprint is the v1 leaf of the stored (secret) salt: byte for byte the shared code.
  const row = (
    await app.city.db.query<{ salt: Buffer; created_day: string }>(
      'SELECT salt, created_day FROM count_log_pending WHERE agent_id=$1',
      [id],
    )
  ).rows[0]!;
  assert.equal(
    entry.fingerprint,
    toHex(await agentLeafHash(id, new Uint8Array(row.salt), row.created_day)),
  );
});

test('the next checkpoint confirms exactly the pending fingerprint', async (t) => {
  const { app, log, feed } = await fixture(t);
  const alice = await owner(app, 'Confirm Alice');
  const id = await agent(app, alice.cookie, 'Confirm Alpha');
  const pending = (await feed()).json().entries[0];
  const { checkpoint } = await log.checkpoint();
  const leaf = (
    await app.city.db.query<{ idx: number; leaf_hash: Buffer }>(
      'SELECT idx, leaf_hash FROM count_log_leaves WHERE agent_id=$1',
      [id],
    )
  ).rows[0]!;
  assert.equal(Buffer.from(leaf.leaf_hash).toString('hex'), pending.fingerprint);
  const confirmed = (await feed()).json().entries[0];
  assert.deepEqual(
    { status: confirmed.status, idx: confirmed.idx, date: confirmed.checkpoint_date },
    { status: 'confirmed', idx: Number(leaf.idx), date: checkpoint.date },
  );
  assert.equal(confirmed.minute, pending.minute);
});

test('an agent gone before its checkpoint is shown as removed, never hidden', async (t) => {
  const { app, log, feed } = await fixture(t);
  const alice = await owner(app, 'Drop Alice');
  await agent(app, alice.cookie, 'Drop Alpha');
  // The agent disappears from the workspace before 00:10 (a purge).
  await app.city.db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]'::jsonb) WHERE operator_id=$1`,
    [alice.id],
  );
  await log.checkpoint();
  assert.equal((await feed()).json().entries[0].status, 'removed');
  assert.equal((await feed()).json().entries[0].idx, undefined);
});

test('newest first with a stable cursor; settled pages are cached for a day', async (t) => {
  const { app, log, feed } = await fixture(t);
  const alice = await owner(app, 'Cursor Alice');
  for (let i = 0; i < 5; i++) await agent(app, alice.cookie, `Cursor ${i}`);
  const first = (await feed('?limit=2')).json();
  assert.equal(first.entries.length, 2);
  assert.ok(first.next);
  // A new agent arrives: the next page is unchanged (cursor by sequence, not offset).
  await agent(app, alice.cookie, 'Cursor late');
  const second = await feed(`?limit=2&before=${first.next}`);
  const third = (await feed(`?limit=2&before=${second.json().next}`)).json();
  const all = [...first.entries, ...second.json().entries, ...third.entries].map(
    (e) => e.fingerprint,
  );
  assert.equal(new Set(all).size, 5);
  assert.equal(third.next, null);
  // Still pending: a short cache. Confirmed entries may still be removed, so an older page is
  // cached only until the next 00:10 checkpoint.
  assert.match(second.headers['cache-control'] as string, /max-age=2,/);
  await log.checkpoint();
  const confirmed = await feed(`?limit=2&before=${first.next}`);
  const age = Number(/max-age=(\d+)/.exec(confirmed.headers['cache-control'] as string)![1]);
  assert.ok(age > 2 && age <= 86_400, String(age));
  assert.ok(
    Date.now() + age * 1000 <= nextCheckpointAt(Date.now()) + 1000,
    'cached no longer than until the next checkpoint',
  );
  // The head stays live.
  assert.match((await feed()).headers['cache-control'] as string, /max-age=2,/);
  assert.equal((await feed('?limit=500')).statusCode, 400);
  assert.equal((await feed('?other=1')).statusCode, 400);
});

test('demo seeds and excluded operators are never in the feed; the table is append-only', async (t) => {
  const { app } = await fixture(t);
  const alice = await owner(app, 'Demo Alice');
  const demo = await app.inject({
    method: 'POST',
    url: '/api/demo/start',
    headers: { ...headers, cookie: alice.cookie },
    payload: '{}',
  });
  assert.equal(demo.statusCode, 200);
  assert.equal(
    Number((await app.city.db.query('SELECT count(*)::int AS n FROM count_log_pending')).rows[0].n),
    0,
  );
  await agent(app, alice.cookie, 'Excluded Alpha');
  const excludedLog = createCountLog({
    db: app.city.db,
    clock: () => Date.now(),
    excludedOperators: [alice.id],
  });
  assert.deepEqual((await excludedLog.feed({})).entries, []);
  await assert.rejects(app.city.db.query("UPDATE count_log_pending SET created_minute='x'"));
  await assert.rejects(app.city.db.query('DELETE FROM count_log_pending'));
});

test('an odd createdAt never fails the workspace write: the log falls back to now', async (t) => {
  const { app, feed } = await fixture(t);
  const alice = await owner(app, 'Odd Alice');
  for (const createdAt of ['infinity', '10000-01-01T00:00:00Z', 'not a date', 12345]) {
    const id = `odd-${String(createdAt).replace(/[^a-z0-9]/gi, '')}`;
    await app.city.db.query(
      `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
         COALESCE(data->'agents','[]'::jsonb) || jsonb_build_array(jsonb_build_object('id',$2::text,'createdAt',$3::jsonb)))
       WHERE operator_id=$1`,
      [alice.id, id, JSON.stringify(createdAt)],
    );
    const row = (
      await app.city.db.query<{ created_day: string }>(
        'SELECT created_day FROM count_log_pending WHERE agent_id=$1',
        [id],
      )
    ).rows[0];
    assert.equal(row?.created_day, new Date().toISOString().slice(0, 10), String(createdAt));
  }
  assert.equal((await feed()).json().entries.length, 4);
  // The workspace write went through every time.
  const agents = (
    await app.city.db.query<{ n: number }>(
      "SELECT jsonb_array_length(data->'agents') AS n FROM workspaces WHERE operator_id=$1",
      [alice.id],
    )
  ).rows[0]!;
  assert.equal(Number(agents.n), 4);
});

test('backfill: agents created before the feed existed get pending rows in creation order, once', async (t) => {
  const { app, feed } = await fixture(t);
  const alice = await owner(app, 'Backfill Alice');
  const db = app.city.db;
  // As before migration 47: the trigger is not there yet.
  await db.query('ALTER TABLE workspaces DISABLE TRIGGER count_log_pending_on_update');
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push(await agent(app, alice.cookie, `Backfill ${i}`));
  await db.query('ALTER TABLE workspaces ENABLE TRIGGER count_log_pending_on_update');
  const later = await agent(app, alice.cookie, 'Backfill live');
  const count = async () =>
    Number((await db.query('SELECT count(*)::int AS n FROM count_log_pending')).rows[0].n);
  assert.equal(await count(), 1);
  const added = Number(
    (await db.query<{ n: number }>('SELECT count_log_backfill_pending() AS n')).rows[0]!.n,
  );
  assert.equal(added, 3);
  assert.equal(await count(), 4);
  // Idempotent.
  assert.equal(
    Number((await db.query<{ n: number }>('SELECT count_log_backfill_pending() AS n')).rows[0]!.n),
    0,
  );
  // Newest created first, whatever the insertion order; real creation minutes.
  const entries = (await feed()).json().entries as Array<{ fingerprint: string; minute: string }>;
  const byAgent = new Map(
    (
      await db.query<{ agent_id: string; leaf_hash: Buffer }>(
        'SELECT agent_id, leaf_hash FROM count_log_pending',
      )
    ).rows.map((row) => [Buffer.from(row.leaf_hash).toString('hex'), row.agent_id]),
  );
  assert.deepEqual(
    entries.map((entry) => byAgent.get(entry.fingerprint)),
    [later, ...ids.slice().reverse()],
  );
});

test('running numbers: pending entries get n = checkpoint size + creation order; the checkpoint keeps them', async (t) => {
  const { app, feed } = await fixture(t);
  const alice = await owner(app, 'Numbers Alice');
  await agent(app, alice.cookie, 'Numbers 0');
  await agent(app, alice.cookie, 'Numbers 1');
  // Today's checkpoint (tree_size 2); the agents after it are pending for tomorrow's.
  const today = Date.now();
  await createCountLog({ db: app.city.db, clock: () => today }).checkpoint();
  for (let i = 2; i < 5; i++) await agent(app, alice.cookie, `Numbers ${i}`);
  const before = (await feed()).json();
  assert.equal(before.total_now, 5);
  const pending = before.entries.filter((e: { status: string }) => e.status === 'pending');
  assert.deepEqual(
    pending.map((e: { n: number }) => e.n),
    [4, 3, 2],
  );
  for (const entry of before.entries.filter((e: { status: string }) => e.status === 'confirmed'))
    assert.equal(entry.n, undefined);
  // The next checkpoint assigns exactly those numbers.
  const next = createCountLogNextDay(app);
  await next.checkpoint();
  const after = (await feed()).json();
  const idxOf = new Map(
    after.entries.map((e: { fingerprint: string; idx: number }) => [e.fingerprint, e.idx]),
  );
  for (const entry of pending) assert.equal(idxOf.get(entry.fingerprint), entry.n);
  assert.equal(after.total_now, 5);
});

test('the page cursor carries no time: a bare sequence number, looked up on the server', async (t) => {
  const { app, feed } = await fixture(t);
  const alice = await owner(app, 'Cursor time Alice');
  for (let i = 0; i < 3; i++) await agent(app, alice.cookie, `Cursor time ${i}`);
  const first = (await feed('?limit=1')).json();
  assert.match(first.next, /^\d+$/);
  // No date, minute or millisecond time in it, in any form.
  assert.ok(!/\d{8}|T\d{2}|Z|\d{13}/.test(first.next), first.next);
  const second = (await feed(`?limit=1&before=${first.next}`)).json();
  assert.equal(second.entries.length, 1);
  assert.notEqual(second.entries[0].fingerprint, first.entries[0].fingerprint);
  // An unknown cursor is an empty page, never the newest page again; a time-shaped one is refused.
  assert.deepEqual((await feed('?before=999999')).json().entries, []);
  assert.equal((await feed('?before=20261001T1200Z.1.1')).statusCode, 400);
});
