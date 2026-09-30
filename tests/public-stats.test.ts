import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import {
  AI_AGENTS_TOTAL_SQL,
  countAiAgentsTotal,
  createPublicStats,
  PUBLIC_STATS_LEASE_MS,
  PUBLIC_STATS_RETRY_MS,
  sqlPublicStatsStore,
  parseExcludedOperators,
  PUBLIC_STATS_CACHE_CONTROL,
  PUBLIC_STATS_RATE,
  PUBLIC_STATS_TTL_MS,
} from '../server/stats/public-stats.js';
import { publicStatsMigration } from '../server/stats/schema.js';
import { ownerApi, type App } from './oauth-helpers.js';

const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

const agent = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Agent ${id}`,
  isDemo: false,
  createdAt: '2026-09-27T00:00:00.000Z',
  revokedAt: null,
  ...extra,
});

async function table(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create();
  t.after(() => db.close());
  await db.exec('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  const put = (operatorId: string, agents: unknown[] | undefined) =>
    db.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
      operatorId,
      JSON.stringify(agents === undefined ? { jobs: [] } : { agents, jobs: [] }),
    ]);
  return { db, put };
}

test('count definition: distinct agents in every workspace kind, revoked and hosted kept, seeded demo and excluded left out', async (t) => {
  const { db, put } = await table(t);
  assert.equal(await countAiAgentsTotal(db), 0);
  // An owner account: one live, one revoked, one paused and one hosted (isDemo) agent, and the
  // three sample agents seeded by /api/demo/start (demoKey).
  await put('owner-1', [
    agent('a1'),
    agent('h1', { mode: 'hosted', isDemo: true }),
    agent('a2', { revokedAt: '2026-09-27T01:00:00.000Z' }),
    agent('a3', { pausedAt: '2026-09-27T01:00:00.000Z' }),
    agent('d1', { isDemo: true, demoKey: 'Scout' }),
    agent('d2', { isDemo: true, demoKey: 'Relay' }),
    agent('d3', { isDemo: true, demoKey: 'Checker' }),
  ]);
  // An unclaimed partition: an anonymous template agent (hosted, isDemo), an anonymous external
  // agent and a room-invite guest.
  await put('bucket-1', [
    agent('t1', { mode: 'hosted', isDemo: true, createdBy: { kind: 'anonymous-client' } }),
    agent('u1', { createdBy: { kind: 'anonymous-client' } }),
    agent('g1', { createdBy: { kind: 'anonymous-client' } }),
  ]);
  // An AI-owned workspace, an empty workspace and a legacy document without an agents array.
  await put('ai-1', [agent('w1')]);
  await put('empty', []);
  await put('legacy', undefined);
  assert.equal(await countAiAgentsTotal(db), 8);
  // An id seen in two documents (never expected; a claim moves it atomically) counts once.
  await put('owner-2', [agent('u1')]);
  assert.equal(await countAiAgentsTotal(db), 8);
  // Excluded synthetic accounts (e.g. the production canary) do not count.
  assert.equal(await countAiAgentsTotal(db, ['owner-1']), 4);
  assert.equal(await countAiAgentsTotal(db, ['owner-1', 'bucket-1', 'owner-2']), 1);
});

test('excluded operators are parsed strictly', () => {
  assert.deepEqual(parseExcludedOperators(undefined), []);
  assert.deepEqual(parseExcludedOperators(' '), []);
  assert.deepEqual(parseExcludedOperators('a-1, b_2,a-1'), ['a-1', 'b_2']);
  assert.throws(() => parseExcludedOperators("x' OR 1=1"), /operator ids/);
});

/** A database with workspaces, the migration 28 table, and a counter of aggregate queries. */
async function shared(t: { after: (fn: () => Promise<unknown>) => void }) {
  const { db, put } = await table(t);
  await db.exec(publicStatsMigration.sql);
  let counts = 0;
  let fail = false;
  const counted = {
    query: (async (sql: string, params?: unknown[]) => {
      if (sql === AI_AGENTS_TOTAL_SQL) {
        counts++;
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (fail) throw new Error('database unavailable');
      }
      return db.query(sql, params as never);
    }) as never,
  };
  return {
    db,
    put,
    counted,
    counts: () => counts,
    setFail: (value: boolean) => {
      fail = value;
    },
  };
}

test('one instance: one count per TTL, shared by concurrent callers, stale on failure', async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1'), agent('a2'), agent('a3')]);
  let now = 1_000_000;
  const stats = createPublicStats({ clock: () => now, db: s.counted });
  const [a, b, c] = await Promise.all([stats.get(), stats.get(), stats.get()]);
  assert.equal(s.counts(), 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
  assert.deepEqual(a, { ai_agents_total: 3, updated_at: new Date(now).toISOString() });
  await s.put('owner-2', [agent('a4')]);
  now += PUBLIC_STATS_TTL_MS - 1;
  assert.equal((await stats.get()).ai_agents_total, 3);
  assert.equal(s.counts(), 1);
  now += 1;
  assert.equal((await stats.get()).ai_agents_total, 4);
  assert.equal(s.counts(), 2);
  // A failed refresh keeps serving the last value.
  s.setFail(true);
  now += PUBLIC_STATS_TTL_MS;
  assert.equal((await stats.get()).ai_agents_total, 4);
  // Without any value, the failure surfaces.
  const cold = createPublicStats({
    clock: () => now,
    db: { query: (async () => Promise.reject(new Error('down'))) as never },
  });
  await assert.rejects(cold.get(), /down/);
});

test('many instances share one row: about one count per TTL globally', async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1'), agent('a2')]);
  let now = 2_000_000;
  const instances = Array.from({ length: 5 }, () =>
    createPublicStats({ clock: () => now, db: s.counted }),
  );
  // Cold start: the very first requests may count locally (nothing stored yet), but only the
  // lease winner writes; after that every instance reads the row.
  await Promise.all(instances.map((x) => x.get()));
  const cold = s.counts();
  assert.ok(cold >= 1 && cold <= instances.length, `cold counts ${cold}`);
  now += PUBLIC_STATS_RETRY_MS;
  const warm = await Promise.all(instances.map((x) => x.get()));
  assert.ok(warm.every((v) => v.ai_agents_total === 2));
  assert.equal(new Set(warm.map((v) => v.updated_at)).size, 1, 'one shared value');
  // Every later TTL: exactly one count across all instances.
  for (let round = 1; round <= 3; round++) {
    await s.put(`owner-${round + 1}`, [agent(`n${round}`)]);
    now += PUBLIC_STATS_TTL_MS;
    const before = s.counts();
    await Promise.all(instances.map((x) => x.get()));
    now += PUBLIC_STATS_RETRY_MS;
    const values = await Promise.all(instances.map((x) => x.get()));
    assert.equal(s.counts() - before, 1, `round ${round}`);
    assert.ok(
      values.every((v) => v.ai_agents_total === 2 + round),
      `round ${round}`,
    );
  }
});

test("the refresh lease runs on the database clock; a crashed winner's lease expires", async (t) => {
  const s = await shared(t);
  await s.put('owner-1', [agent('a1')]);
  const store = sqlPublicStatsStore(s.db);
  let now = 3_000_000;
  assert.equal(
    await store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS),
    true,
  );
  assert.equal(await store.write('ai_agents_total', 7, now), true);
  now += PUBLIC_STATS_TTL_MS;
  // A winner claims the stale row and "crashes" before writing.
  assert.equal(
    await store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS),
    true,
  );
  // The lease is stamped in database time (not the instance clock, which is at 3,015,000 here).
  const lease = Number(
    (await s.db.query<{ r: string }>('SELECT refreshing_until AS r FROM public_stats')).rows[0]!.r,
  );
  assert.ok(Math.abs(lease - (Date.now() + PUBLIC_STATS_LEASE_MS)) < 5_000, `lease ${lease}`);
  // While the lease lives, nobody else wins, whatever their own clock says, and readers serve 7.
  assert.equal(
    await store.claim(
      'ai_agents_total',
      now + 10 * PUBLIC_STATS_LEASE_MS,
      PUBLIC_STATS_TTL_MS,
      PUBLIC_STATS_LEASE_MS,
    ),
    false,
  );
  const reader = createPublicStats({ clock: () => now + 1, db: s.counted });
  assert.equal((await reader.get()).ai_agents_total, 7);
  assert.equal(s.counts(), 0);
  // Once the lease has expired in database time, another instance takes over and counts.
  await s.db.query('UPDATE public_stats SET refreshing_until = refreshing_until - $1', [
    2 * PUBLIC_STATS_LEASE_MS,
  ]);
  const next = createPublicStats({ clock: () => now + 2, db: s.counted });
  assert.equal((await next.get()).ai_agents_total, 1);
  assert.equal(s.counts(), 1);
});

test('a slow count never overwrites a newer total: values are stamped with the claim time', async (t) => {
  const s = await shared(t);
  const store = sqlPublicStatsStore(s.db);
  const ttl = PUBLIC_STATS_TTL_MS;
  const t1 = 4_000_000;
  // Instance A claims at t1 and starts a slow count (it will find 4 agents).
  assert.equal(await store.claim('ai_agents_total', t1, ttl, PUBLIC_STATS_LEASE_MS), true);
  // A's lease expires (database time); instance B claims later, at t2, and stores 5 first.
  await s.db.query('UPDATE public_stats SET refreshing_until = 0');
  const t2 = t1 + 1;
  assert.equal(await store.claim('ai_agents_total', t2, ttl, PUBLIC_STATS_LEASE_MS), true);
  assert.equal(await store.write('ai_agents_total', 5, t2), true);
  // A finishes last, but its claim is older: refused, and the newer total stays.
  assert.equal(await store.write('ai_agents_total', 4, t1), false);
  assert.deepEqual(await store.read('ai_agents_total'), { value: 5, refreshedAt: t2 });
  // Through the service: the value is stamped with the claim time, not the finish time.
  await s.put('owner-1', [agent('a1'), agent('a2')]);
  let clock = t2 + ttl;
  const service = createPublicStats({
    db: {
      query: (async (sql: string, params?: unknown[]) => {
        if (sql === AI_AGENTS_TOTAL_SQL) clock += 3_000; // the count takes 3 s
        return s.db.query(sql, params as never);
      }) as never,
    },
    clock: () => clock,
  });
  const got = await service.get();
  assert.equal(got.ai_agents_total, 2);
  assert.equal(got.updated_at, new Date(t2 + ttl).toISOString());
  assert.equal((await store.read('ai_agents_total'))!.refreshedAt, t2 + ttl);
});

async function stats(app: App, remoteAddress = '127.0.0.1') {
  const res = await app.inject({ method: 'GET', url: '/api/public/stats', remoteAddress });
  return res;
}

test('GET /api/public/stats: unauthenticated, cacheable, only the number, and counts every way in', async (t) => {
  let now = Date.parse('2026-09-27T12:00:00.000Z');
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const tick = () => (now += PUBLIC_STATS_TTL_MS);

  const empty = await stats(app);
  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.headers['cache-control'], PUBLIC_STATS_CACHE_CONTROL);
  assert.equal(empty.headers['set-cookie'], undefined);
  assert.match(String(empty.headers['content-type']), /^application\/json/);
  assert.deepEqual(Object.keys(empty.json()).sort(), ['ai_agents_total', 'updated_at']);
  assert.equal(empty.json().ai_agents_total, 0);
  assert.equal(empty.json().updated_at, new Date(now).toISOString());

  // An owner creates an external and a hosted agent (both count), then starts the console demo,
  // whose three seeded sample agents (demoKey) do not.
  const register = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Ticker owner', password: 'Synthetic ticker password' }),
  });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = `cc_session=${register.cookies.find((c) => c.name === 'cc_session')!.value}`;
  const created: Record<string, string> = {};
  for (const mode of ['external', 'hosted'] as const) {
    const res = await ownerApi(app, cookie, '/api/agents', {
      name: `Ticker ${mode}`,
      description: 'Synthetic ticker agent',
      capability: 'extract',
      mode,
    });
    assert.ok([200, 201].includes(res.statusCode), res.body);
    assert.equal(res.json().agent.isDemo, mode === 'hosted');
    created[mode] = res.json().agent.id;
  }
  assert.equal((await ownerApi(app, cookie, '/api/demo/start', {})).statusCode, 200);
  const snapshot = (await ownerApi(app, cookie, '/api/snapshot')).json();
  assert.equal(snapshot.agents.length, 5);

  // Within the TTL the cached value is served.
  assert.equal((await stats(app)).json().ai_agents_total, 0);
  tick();
  assert.equal((await stats(app)).json().ai_agents_total, 2);

  // An AI client creates agents anonymously (unclaimed): an external runtime and a template agent
  // (hosted, so isDemo) both count.
  const anonymous = async (body: Record<string, unknown>) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/public/agents',
      remoteAddress: '198.51.100.7',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ ...body, idempotency_key: randomUUID() }),
    });
    assert.equal(res.statusCode, 201, res.body);
    return res.json();
  };
  const external = await anonymous({
    manifest: {
      apiVersion: 'centralcity.agent/v1',
      kind: 'Agent',
      metadata: { name: 'ticker-anonymous' },
      spec: { capabilities: ['research'], runtime: { mode: 'external' } },
    },
  });
  assert.equal(external.agent.isDemo, false);
  assert.equal((await anonymous({ template: 'template:extractor@1.0.0' })).agent.isDemo, true);
  tick();
  assert.equal((await stats(app)).json().ai_agents_total, 4);

  // Claiming moves the unclaimed agent into the owner's account: still one agent, not two.
  const claimToken = external.claim?.claim_token;
  assert.match(String(claimToken), /^ccclaim_/);
  const claimed = await ownerApi(app, cookie, '/api/agents/claim', { claim_token: claimToken });
  assert.equal(claimed.statusCode, 200, claimed.body);
  // Revoking keeps it counted: the count is of agents that ever joined.
  const revoked = await ownerApi(app, cookie, `/api/agents/${created.external}/revoke`, {});
  assert.equal(revoked.statusCode, 200, revoked.body);
  tick();
  const after = await stats(app);
  assert.equal(after.json().ai_agents_total, 4);
  assert.equal(after.json().updated_at, new Date(now).toISOString());
});

test('GET /api/public/stats is rate limited per client address', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  for (let i = 0; i < PUBLIC_STATS_RATE.max; i++)
    assert.equal((await stats(app, '203.0.113.9')).statusCode, 200);
  const limited = await stats(app, '203.0.113.9');
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  // Another address is unaffected.
  assert.equal((await stats(app, '203.0.113.10')).statusCode, 200);
});

test('a query string on /api/public/stats is redirected at the handler, never reaching the app', async () => {
  const { createHostedHandler, publicStatsRedirect, withoutRewriteParameter } =
    await import('../api/index.js');
  // The Vercel rewrite parameter alone is not a client query: no redirect (no loop).
  for (const url of [
    '/api/public/stats',
    '/api/public/stats?path=public%2Fstats',
    '/api/public/stats?path=public/stats',
  ]) {
    assert.equal(publicStatsRedirect('GET', withoutRewriteParameter(url)), null, url);
  }
  assert.equal(publicStatsRedirect('GET', '/api/public/stats?x=1'), '/api/public/stats');
  assert.equal(publicStatsRedirect('HEAD', '/api/public/stats?'), '/api/public/stats');
  assert.equal(publicStatsRedirect('POST', '/api/public/stats?x=1'), null);
  assert.equal(publicStatsRedirect('GET', '/api/public/statsx?x=1'), null);
  assert.equal(publicStatsRedirect('GET', '/api/public/agents?x=1'), null);

  let created = 0;
  const handler = createHostedHandler(async () => {
    created++;
    throw new Error('the application must not start for a redirected request');
  });
  const written: { status?: number; headers?: Record<string, string>; ended?: boolean } = {};
  const response = {
    writeHead(status: number, headers: Record<string, string>) {
      written.status = status;
      written.headers = headers;
      return this;
    },
    end() {
      written.ended = true;
    },
  };
  await handler(
    { method: 'GET', url: '/api/public/stats?random=123&path=public%2Fstats' } as never,
    response as never,
  );
  assert.equal(created, 0);
  assert.equal(written.status, 308);
  assert.equal(written.headers!.Location, '/api/public/stats');
  assert.match(written.headers!['Cache-Control']!, /s-maxage=/);
  assert.equal(written.ended, true);
});
