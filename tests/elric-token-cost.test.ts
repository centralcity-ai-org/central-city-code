import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  ELRIC_CONFIG,
  ELRIC_COST_UNIT_USD,
  ELRIC_GLOBAL_DAILY_UNITS,
  ELRIC_GLOBAL_DAILY_USD,
  ELRIC_STEP_CONTEXT_TOKENS,
} from '../server/elric/config.js';
import {
  anthropicUnits,
  anthropicWorstUnits,
  ELRIC_ESTIMATE_CHARS_PER_TOKEN,
  elricTokenCostMigration,
  estimateTokens,
} from '../server/elric/token-cost.js';
import { MockAdapter } from '../server/elric/adapter.js';
import { FallbackAdapter } from '../server/elric/anthropic.js';
import { elricFixture } from './elric-fixture.js';

/**
 * H3: Elric's hosted model is priced per token (input USD 1/M, output USD 5/M, cache read
 * 0.1x input, 5-minute cache write 1.25x input), in micro-USD units; the global ceiling is
 * USD 50/day; the self-hosted fallback keeps GPU-second costing.
 */
const usd = (units: number) => Math.round(units * ELRIC_COST_UNIT_USD * 1e6) / 1e6;

test('per-token prices: input, output, cache read and cache write', () => {
  const M = 1_000_000;
  assert.equal(usd(anthropicUnits({ inputTokens: M, outputTokens: 0 })), 1);
  assert.equal(usd(anthropicUnits({ inputTokens: 0, outputTokens: M })), 5);
  assert.equal(
    usd(anthropicUnits({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: M })),
    0.1,
  );
  assert.equal(
    usd(anthropicUnits({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: M })),
    1.25,
  );
  // A typical turn: 1,200 uncached in, 300 out, 4,000 read from cache, 800 written.
  assert.equal(
    anthropicUnits({
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 800,
    }),
    1200 + 1500 + 400 + 1000,
  );
  // At least one unit; missing or bad counts are zero.
  assert.equal(anthropicUnits({ inputTokens: 0, outputTokens: 0 }), 1);
  assert.equal(anthropicUnits({ inputTokens: Number.NaN, outputTokens: -5 }), 1);
  // The worst case writes every input token to the cache.
  assert.equal(anthropicWorstUnits(25_000, 600), 31_250 + 3_000);
  assert.equal(ELRIC_GLOBAL_DAILY_USD, 50);
  assert.equal(ELRIC_GLOBAL_DAILY_UNITS, 50_000_000);
});

test('a per-token turn: real dollars in the turn row, the usage counters and the cost report', async (t) => {
  const f = await elricFixture(t);
  Object.assign(f.small, { pricing: 'anthropic' });
  const s = await f.scene();
  const trigger = await f.say(s.owner, s.room, '@Elric what is next?', s.person);
  f.small.push({
    text: 'An answer.',
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadInputTokens: 4000,
      cacheCreationInputTokens: 800,
    },
  });
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok', JSON.stringify(result));
  const turn = (
    await f.db.query<{
      cost_units: string;
      reserved_units: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    }>(
      'SELECT cost_units,reserved_units,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens FROM elric_turns WHERE owner_id=$1',
      [s.owner.operatorId],
    )
  ).rows[0]!;
  assert.equal(Number(turn.cost_units), 4100); // USD 0.0041
  assert.deepEqual(
    [turn.input_tokens, turn.output_tokens, turn.cache_read_tokens, turn.cache_write_tokens],
    [1200, 300, 4000, 800],
  );
  // The reservation is the per-token worst case per step, not the GPU rate.
  assert.equal(
    Number(turn.reserved_units),
    anthropicWorstUnits(ELRIC_STEP_CONTEXT_TOKENS, ELRIC_CONFIG.maxOutputTokens) *
      ELRIC_CONFIG.maxSteps,
  );
  assert.equal(Number((await f.globalUsage())!.spent_units), 4100);

  const secret = randomBytes(32).toString('base64url');
  const before = process.env.CITY_OPS_SECRET;
  process.env.CITY_OPS_SECRET = secret;
  t.after(() => {
    if (before === undefined) delete process.env.CITY_OPS_SECRET;
    else process.env.CITY_OPS_SECRET = before;
  });
  const report = await f.app.inject({
    method: 'GET',
    url: '/api/ops/elric/cost?days=1',
    headers: { 'x-city-request': '1', authorization: `Bearer ${secret}` },
  });
  assert.equal(report.statusCode, 200, report.body);
  const body = report.json();
  assert.equal(body.daily[0].t1.cost_units, 4100);
  assert.equal(body.budget_usd, 50);
});

test('migration 45 rescales stored units x2500 and keeps elric_turns append-only', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene();
  const day = '2026-09-29';
  await f.db.query(
    `INSERT INTO elric_turns(id,owner_id,agent_id,room_id,invoker_member_id,invoker_kind,
       source_seq,tier,cost_units,reserved_units,outcome,created_at)
     VALUES ($1,$2,$3,$4,'m','owner',1,1,2,16,'ok',$5)`,
    [randomUUID(), s.owner.operatorId, s.elricId, s.room.id, f.now()],
  );
  await f.db.query(
    'INSERT INTO elric_global_usage(day,reserved_units,spent_units) VALUES ($1,4,3)',
    [day],
  );
  await f.db.query(
    'INSERT INTO elric_usage(owner_id,day,reserved_units,spent_units) VALUES ($1,$2,4,3)',
    [s.owner.operatorId, day],
  );
  await f.db.query(
    'INSERT INTO elric_cost_erased(day_index,tier,turns,cost_units) VALUES (1,1,1,7)',
  );
  // Replays the migration's SQL on these old-unit rows (ADD COLUMN IF NOT EXISTS is a no-op).
  await f.db.transaction((tx) => tx.exec(elricTokenCostMigration.sql));
  const one = async (sql: string, params: unknown[] = []) =>
    (await f.db.query<Record<string, string>>(sql, params)).rows[0]!;
  assert.deepEqual(
    await one('SELECT cost_units::int AS c, reserved_units::int AS r FROM elric_turns'),
    { c: 5000, r: 40_000 },
  );
  assert.deepEqual(
    await one(
      'SELECT reserved_units::int AS r, spent_units::int AS s FROM elric_global_usage WHERE day=$1',
      [day],
    ),
    { r: 10_000, s: 7500 },
  );
  assert.deepEqual(
    await one(
      'SELECT reserved_units::int AS r, spent_units::int AS s FROM elric_usage WHERE day=$1',
      [day],
    ),
    { r: 10_000, s: 7500 },
  );
  assert.deepEqual(await one('SELECT cost_units::int AS c FROM elric_cost_erased'), {
    c: 17_500,
  });
  // The trigger is back on.
  await assert.rejects(f.db.query("UPDATE elric_turns SET reason='x'"), /append-only/);
  await assert.rejects(f.db.query('DELETE FROM elric_turns'), /append-only/);
});

test('the fallback wrapper: the primary answers per token, the fallback answers by GPU-seconds', async (t) => {
  const primary = Object.assign(new MockAdapter('hosted-model-1'), {
    pricing: 'anthropic' as const,
  });
  const fallback = new MockAdapter('fallback-model');
  const wrapped = new FallbackAdapter(primary, fallback);
  const f = await elricFixture(t, { models: { adapterFor: () => wrapped, adapters: {} } });
  const s = await f.scene();
  const turnCost = async () =>
    (
      await f.db.query<{ cost_units: string; reserved_units: string }>(
        'SELECT cost_units,reserved_units FROM elric_turns WHERE owner_id=$1 ORDER BY created_at DESC, id DESC LIMIT 1',
        [s.owner.operatorId],
      )
    ).rows[0]!;
  const ask = async (text: string) => {
    const trigger = await f.say(s.owner, s.room, text, s.person);
    const result = await f.elric.run({
      agentId: s.elricId,
      roomId: s.room.id,
      sourceSeq: trigger.message.seq,
    });
    assert.equal(result?.outcome, 'ok', JSON.stringify(result));
    return turnCost();
  };
  const reserved =
    anthropicWorstUnits(ELRIC_STEP_CONTEXT_TOKENS, ELRIC_CONFIG.maxOutputTokens) *
    ELRIC_CONFIG.maxSteps;
  // 1) the primary answers: per-token dollars (1,000 in + 200 out + 3,000 cache read = 2,300 micro-USD).
  primary.push({
    text: 'From the primary.',
    usage: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 3000 },
  });
  const first = await ask('@Elric first question');
  assert.equal(Number(first.cost_units), 2300);
  assert.equal(Number(first.reserved_units), reserved);
  // 2) the primary is rate limited, the fallback answers: the tier's GPU rate, not the primary's token prices.
  primary.push({ error: 'rate_limited' });
  fallback.push({ text: 'From the fallback.', usage: { inputTokens: 4000, outputTokens: 200 } });
  const second = await ask('@Elric second question');
  const gpu = ELRIC_CONFIG.unitsPer1kTokens[1];
  assert.equal(Number(second.cost_units), Math.ceil(4 * gpu.input + 0.2 * gpu.output)); // 1,250
  assert.notEqual(
    Number(second.cost_units),
    anthropicUnits({ inputTokens: 4000, outputTokens: 200 }),
  );
  assert.equal(fallback.calls, 1);
});

test('dense text (CJK, emoji): the estimate and the per-step reservation cover it', async (t) => {
  // the primary's tokenizer is close to 1-2 characters per token for CJK and emoji; the estimate uses 2.
  assert.equal(ELRIC_ESTIMATE_CHARS_PER_TOKEN, 2);
  const cjk = '会议记录：明天下午三点讨论预算，请大家准备数据。'.repeat(200);
  const emoji = '🎉🚀✅'.repeat(500); // 2,500 UTF-16 units (the estimate counts JS length)
  assert.equal(estimateTokens(cjk.length), Math.ceil(cjk.length / 2));
  assert.equal(estimateTokens(emoji.length), 1250);
  assert.equal(estimateTokens(0), 0);
  // The largest context a step can build, counted in characters, fits the reservation at 2 c/t.
  const maxChars = ELRIC_CONFIG.transcriptChars + ELRIC_CONFIG.toolResultChars + 12_000;
  assert.ok(estimateTokens(maxChars) <= ELRIC_STEP_CONTEXT_TOKENS);

  // End to end: a room full of CJK and emoji. The pre-call estimate stays within the reservation,
  // and the turn's real spend (here the mock bills 1 token per character, the dense worst case
  // in practice for the input) stays within what was reserved.
  const f = await elricFixture(t);
  Object.assign(f.large, { pricing: 'anthropic' });
  Object.assign(f.small, { pricing: 'anthropic' });
  const s = await f.scene();
  for (let i = 0; i < 40; i++)
    await f.say(s.host, s.room, `${cjk.slice(0, 900)} ${emoji.slice(0, 300)}`, s.hostAgent);
  const trigger = await f.say(s.owner, s.room, '@Elric 总结一下这个房间 🙏', s.person);
  let promptChars = 0;
  // The mock bills 1 input token per prompt character (the dense worst case in practice).
  const answer = (request: { system: string; messages: unknown[] }) => {
    promptChars = request.system.length + JSON.stringify(request.messages).length;
    return { text: '好的 ✅', usage: { inputTokens: promptChars, outputTokens: 10 } };
  };
  f.small.push(answer);
  f.large.push(answer);
  const result = await f.elric.run({
    agentId: s.elricId,
    roomId: s.room.id,
    sourceSeq: trigger.message.seq,
  });
  assert.equal(result?.outcome, 'ok', JSON.stringify(result));
  assert.ok(promptChars > 30_000, `a dense context was sent (${promptChars} chars)`);
  const turn = (
    await f.db.query<{ cost_units: string; reserved_units: string }>(
      'SELECT cost_units,reserved_units FROM elric_turns WHERE owner_id=$1',
      [s.owner.operatorId],
    )
  ).rows[0]!;
  // 1 token per character is billed in full, and it is still inside the reservation.
  assert.ok(Number(turn.cost_units) >= promptChars);
  assert.ok(Number(turn.cost_units) <= Number(turn.reserved_units));
});
