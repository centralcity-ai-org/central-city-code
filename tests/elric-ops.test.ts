import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { listMigrations, runMigrations } from '../server/migrations.js';
import {
  ceilingThreshold,
  onCeilingAlert,
  reserve,
  type CeilingAlert,
} from '../server/elric/budget.js';
import {
  ceilingAlertText,
  deliverCeilingAlert,
  opsAuthorized,
  OPS_SECRET_MIN_CHARS,
} from '../server/elric/ops.js';
import { elricFixture } from './elric-fixture.js';

/**
 * Operator controls (docs/ELRIC.md "Operator controls"): the kill switch and usage routes behind
 * CITY_OPS_SECRET (404 fail closed), aggregates only, and the 50/80/95% ceiling alerts, exactly
 * once per day and threshold, delivered after the commit.
 */
const secret = () => randomBytes(32).toString('base64url');

async function withSecret<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const before = process.env.CITY_OPS_SECRET;
  if (value === undefined) delete process.env.CITY_OPS_SECRET;
  else process.env.CITY_OPS_SECRET = value;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  }
}

// First in this file, before any app registers Elric's schema.
test('migration 42 registers only next to Elric (never on import); without Elric no elric table is touched', async (t) => {
  assert.ok(
    !listMigrations().some((migration) => migration.version === 42),
    'importing budget.ts registers nothing',
  );
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(db as never);
  const tables = await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'elric%'",
  );
  assert.deepEqual(tables.rows, []);
});

test('ops routes: 404 without the right secret, aggregates only, kill switch takes effect', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Ops room');
  const ops = (method: 'GET' | 'POST', url: string, authorization?: string, body?: unknown) =>
    f.app.inject({
      method,
      url,
      headers: {
        'x-city-request': '1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(authorization ? { authorization } : {}),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const good = secret();
  // No secret configured, a short one, a wrong or missing header, or an owner session: 404.
  for (const [configured, header] of [
    [undefined, `Bearer ${good}`],
    ['short-secret', 'Bearer short-secret'],
    [good, `Bearer ${secret()}`],
    [good, undefined],
    [good, good],
  ] as Array<[string | undefined, string | undefined]>)
    await withSecret(configured, async () => {
      assert.equal((await ops('GET', '/api/ops/elric/usage', header)).statusCode, 404);
      assert.equal(
        (await ops('POST', '/api/ops/elric/kill', header, { enabled: true })).statusCode,
        404,
      );
    });
  const asOwner = await f.call(s.owner.cookie, 'GET', '/api/ops/elric/usage');
  assert.equal(asOwner.statusCode, 404);

  await withSecret(good, async () => {
    f.small.push({ text: 'An answer.' });
    await f.say(s.owner, s.room, '@Elric what is next?', s.person);
    await f.elric.drain();
    const usage = await ops('GET', '/api/ops/elric/usage', `Bearer ${good}`);
    assert.equal(usage.statusCode, 200, usage.body);
    const body = usage.json();
    assert.equal(body.today.day, new Date(f.now()).toISOString().slice(0, 10));
    assert.equal(body.today.ceiling_units, 50_000_000);
    assert.equal(body.today.ceiling_usd, 50);
    assert.equal(body.today.invocations, 1);
    assert.ok(body.today.spent_units > 0);
    assert.equal(body.days.length, 6);
    assert.deepEqual(body.kill, {
      killed: false,
      env: false,
      database: false,
      updated_at: null,
      updated_by: null,
    });
    // Aggregates only: no owner, room, agent or turn appears.
    for (const id of [s.owner.operatorId, s.room.id, s.elricId, s.owner.name, 'Ops room'])
      assert.ok(!usage.body.includes(id), id);

    // The kill switch: on stops the next invocation before any model call; off restores it.
    const on = await ops('POST', '/api/ops/elric/kill', `Bearer ${good}`, { enabled: true });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(on.json().kill.killed, true);
    assert.equal(on.json().kill.updated_by, 'ops');
    const calls = f.adapterCalls();
    await f.say(s.owner, s.room, '@Elric anything?', s.person);
    await f.elric.drain();
    assert.equal(f.adapterCalls(), calls, 'no model call while killed');
    assert.equal((await f.turns(s.owner.operatorId)).at(-1)!.outcome, 'refused_kill');
    const off = await ops('POST', '/api/ops/elric/kill', `Bearer ${good}`, { enabled: false });
    assert.equal(off.json().kill.killed, false);
    const bad = await ops('POST', '/api/ops/elric/kill', `Bearer ${good}`, { enabled: 'yes' });
    assert.equal(bad.statusCode, 400);
  });
});

test('ceiling alerts: 50/80/95% once per day each, after the commit, even when the total dips', async (t) => {
  const f = await elricFixture(t, { config: { globalDailyUnits: 100 } });
  const s = await f.scene('Ceiling room');
  const alerts: CeilingAlert[] = [];
  onCeilingAlert(f.db, (alert) => alerts.push(alert)); // replaces the log + webhook sink
  const day = new Date(f.now()).toISOString().slice(0, 10);
  let seq = 0;
  const take = async (units: number) => {
    seq++;
    const leaseId = randomUUID();
    await f.db.query(
      `INSERT INTO elric_invocations(agent_id,room_id,source_seq,owner_id,invoker_member_id,
         invoker_kind,status,lease_id,locked_until,created_at)
       VALUES($1,$2,$3,$4,$5,'owner','running',$6,$7,$8)`,
      [s.elricId, s.room.id, seq, s.owner.operatorId, s.person, leaseId, f.now() + 60_000, f.now()],
    );
    return reserve(
      f.db,
      { ...f.elric.config, globalDailyUnits: 100 },
      {
        ownerId: s.owner.operatorId,
        kind: 'short',
        units,
        day,
        invocation: { agentId: s.elricId, roomId: s.room.id, sourceSeq: seq, leaseId },
      },
    );
  };
  assert.equal((await take(40)).ok, true);
  assert.equal(alerts.length, 0);
  assert.equal((await take(15)).ok, true); // 55%
  assert.deepEqual(
    alerts.map((alert) => alert.percent),
    [50],
  );
  // A settle releases most of a reservation: the total dips below 50% ...
  await f.db.query('UPDATE elric_global_usage SET reserved_units=10, spent_units=5 WHERE day=$1', [
    day,
  ]);
  assert.equal((await take(40)).ok, true); // ... and crossing 50% again stays silent (55%)
  assert.equal(alerts.length, 1);
  assert.equal((await take(30)).ok, true); // 85%: straight to 80
  assert.deepEqual(
    alerts.map((alert) => alert.percent),
    [50, 80],
  );
  assert.equal((await take(12)).ok, true); // 97%
  assert.deepEqual(
    alerts.map((alert) => alert.percent),
    [50, 80, 95],
  );
  assert.deepEqual(alerts[2], { day, percent: 95, total_units: 97, ceiling_units: 100 });
  // A refused reservation (over the ceiling) announces nothing.
  assert.equal((await take(10)).ok, false);
  assert.equal(alerts.length, 3);
  const row = await f.db.query<{ alerted_percent: number }>(
    'SELECT alerted_percent FROM elric_global_usage WHERE day=$1',
    [day],
  );
  assert.equal(row.rows[0]!.alerted_percent, 95);
});

test('alert delivery: log line always; webhook with aggregates only; failures contained', async () => {
  const alert: CeilingAlert = {
    day: '2026-10-01',
    percent: 80,
    total_units: 40_100_000,
    ceiling_units: 50_000_000,
  };
  assert.equal(
    ceilingAlertText(alert),
    "Elric is at 80% of today's USD 50 ceiling (USD 40 reserved or spent, 2026-10-01 UTC).",
  );
  const lines: string[] = [];
  const sent: Array<{ url: string; body: string }> = [];
  await deliverCeilingAlert(
    alert,
    {},
    async () => ({ status: 200 }),
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), { event: 'elric_ceiling_alert', ...alert });
  const env = { CITY_OPS_ALERT_WEBHOOK: 'https://hooks.example.com/elric' };
  await deliverCeilingAlert(
    alert,
    env,
    async (url, body) => {
      sent.push({ url, body });
      return { status: 204 };
    },
    (line) => lines.push(line),
  );
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(sent[0]!.body)).sort(), [
    'ceiling_units',
    'day',
    'percent',
    'text',
    'total_units',
  ]);
  // A failing or refusing webhook is logged, never thrown.
  await deliverCeilingAlert(
    alert,
    env,
    async () => {
      throw new Error('not_public');
    },
    (line) => lines.push(line),
  );
  await deliverCeilingAlert(
    alert,
    env,
    async () => ({ status: 500 }),
    (line) => lines.push(line),
  );
  assert.equal(
    lines.filter((line) => JSON.parse(line).event === 'elric_ceiling_alert_failed').length,
    2,
  );
});

test('the secret check and the threshold rule', () => {
  const value = secret();
  assert.ok(value.length >= OPS_SECRET_MIN_CHARS);
  assert.equal(opsAuthorized(`Bearer ${value}`, value), true);
  assert.equal(opsAuthorized(`Bearer ${value}x`, value), false);
  assert.equal(opsAuthorized(value, value), false);
  assert.equal(opsAuthorized(`Bearer ${value}`, undefined), false);
  const short = value.slice(0, OPS_SECRET_MIN_CHARS - 1);
  assert.equal(opsAuthorized(`Bearer ${short}`, short), false);
  assert.equal(ceilingThreshold(49, 100, 0), null);
  assert.equal(ceilingThreshold(50, 100, 0), 50);
  assert.equal(ceilingThreshold(96, 100, 0), 95);
  assert.equal(ceilingThreshold(96, 100, 95), null);
  assert.equal(ceilingThreshold(81, 100, 50), 80);
});
