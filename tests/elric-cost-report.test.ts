import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { DAY_MS } from '../server/elric/config.js';
import { buildCostReport, COST_REPORT_MAX_DAYS } from '../server/elric/cost-report.js';
import { elricFixture } from './elric-fixture.js';

/** The operator's daily cost report from the turn log: per day and tier, vs the USD 50/day budget. */
const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const TODAY = Math.floor(NOW / DAY_MS);

test('buildCostReport: per day and tier, cumulative vs budget, window bounds', () => {
  const report = buildCostReport(
    [
      { day_index: TODAY, tier: 1, cost_units: 10_000_000, turns: 10 }, // USD 10
      { day_index: TODAY, tier: 2, cost_units: 5_000_000, turns: 2 }, // USD 5
      { day_index: TODAY, tier: 0, cost_units: 0, turns: 5 },
      { day_index: TODAY - 1, tier: 2, cost_units: 25_000_000, turns: 4 }, // USD 25
      { day_index: TODAY - 3, tier: 1, cost_units: 999_999_999, turns: 1 }, // outside a 3-day window
    ],
    NOW,
    3,
  );
  assert.equal(report.from, '2026-09-28');
  assert.equal(report.to, '2026-09-30');
  assert.deepEqual(
    report.daily.map((d) => d.day),
    ['2026-09-30', '2026-09-29', '2026-09-28'],
  );
  const [today, yesterday, empty] = report.daily;
  assert.deepEqual(today.t1, { turns: 10, cost_units: 10_000_000, spend_usd: 10 });
  assert.deepEqual(today.t2, { turns: 2, cost_units: 5_000_000, spend_usd: 5 });
  assert.deepEqual(today.total, { turns: 17, cost_units: 15_000_000, spend_usd: 15 });
  assert.equal(today.percent, 30);
  assert.equal(yesterday.percent, 50);
  assert.deepEqual(empty.total, { turns: 0, cost_units: 0, spend_usd: 0 });
  assert.equal(report.cumulative.total.spend_usd, 40);
  assert.equal(report.cumulative.t1.spend_usd, 10);
  assert.equal(report.cumulative.t2.spend_usd, 30);
  assert.equal(report.budget_usd, 150);
  assert.equal(report.percent_used, 26.67);
});

test('GET /api/ops/elric/cost: secret-gated (404), aggregates only, days validated', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Cost room');
  const good = randomBytes(32).toString('base64url');
  const before = process.env.CITY_OPS_SECRET;
  process.env.CITY_OPS_SECRET = good;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  });
  const get = (url: string, authorization?: string) =>
    f.app.inject({
      method: 'GET',
      url,
      headers: { 'x-city-request': '1', ...(authorization ? { authorization } : {}) },
    });
  const secretWord = 'never-in-the-report';
  const insert = (tier: number, units: number, at: number) =>
    f.db.query(
      `INSERT INTO elric_turns(id,owner_id,agent_id,room_id,invoker_member_id,invoker_kind,
         source_seq,tier,model,cost_units,outcome,reason,created_at)
       VALUES ($1,$2,$3,$4,'m','owner',1,$5,'mock',$6,'ok',$7,$8)`,
      [randomUUID(), s.owner.operatorId, s.elricId, s.room.id, tier, units, secretWord, at],
    );
  const now = f.now();
  await insert(1, 1_000_000, now); // USD 1
  await insert(2, 2_000_000, now - DAY_MS); // USD 2

  assert.equal((await get('/api/ops/elric/cost')).statusCode, 404);
  assert.equal(
    (await get('/api/ops/elric/cost', `Bearer ${randomBytes(32).toString('base64url')}`))
      .statusCode,
    404,
  );
  assert.equal((await f.call(s.owner.cookie, 'GET', '/api/ops/elric/cost')).statusCode, 404);

  const res = await get('/api/ops/elric/cost?days=2', `Bearer ${good}`);
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.daily.length, 2);
  assert.equal(body.daily[0].t1.spend_usd, 1);
  assert.equal(body.daily[1].t2.spend_usd, 2);
  assert.equal(body.cumulative.total.spend_usd, 3);
  assert.equal(body.budget_usd, 100);
  assert.equal(body.percent_used, 3);
  for (const leak of [s.owner.operatorId, s.room.id, s.elricId, 'Cost room', secretWord, 'mock'])
    assert.ok(!res.body.includes(leak), leak);

  assert.equal((await get('/api/ops/elric/cost', `Bearer ${good}`)).json().daily.length, 7);
  for (const bad of ['0', String(COST_REPORT_MAX_DAYS + 1), 'x'])
    assert.equal((await get(`/api/ops/elric/cost?days=${bad}`, `Bearer ${good}`)).statusCode, 400);
});
