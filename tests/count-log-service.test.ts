import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import { generateSigningKey } from '../server/manifest/keys.js';
import {
  createCountLog,
  registerCountLogMigration,
  registerCountLogRoutes,
} from '../server/count-log/index.js';
import {
  fromHex,
  merkleRoot,
  toHex,
  verifyAgentProof,
  verifyChain,
  verifyCheckpointSignature,
} from '../shared/count-log/index.js';
import type { Operator } from '../shared/types.js';

// server/app.ts registers migration 29; registering again is idempotent.
registerCountLogMigration();

const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const DAY = 86_400_000;
type App = Awaited<ReturnType<typeof createApp>>;

async function owner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers,
    payload: JSON.stringify({ name, password: 'Synthetic count-log password' }),
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

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  let now = Date.parse('2026-10-01T00:10:00Z');
  const key = generateSigningKey('count-test');
  const log = createCountLog({ db: app.city.db, clock: () => now, signingKey: key });
  const jwk = key.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  return { app, log, jwk, nextDay: () => (now += DAY) };
}

test('daily checkpoints: counted agents become leaves; claims move, purges withdraw; the chain verifies', async (t) => {
  const { app, log, jwk, nextDay } = await fixture(t);

  // Day 1: nothing yet. A second run the same day is a no-op.
  const first = await log.checkpoint();
  assert.equal(first.created, true);
  assert.equal(first.checkpoint.tree_size, 0);
  assert.equal(first.checkpoint.prev_hash, null);
  assert.equal((await log.checkpoint()).created, false);

  // Day 2: a person with two agents and the console demo (excluded), and one anonymous agent.
  const alice = await owner(app, 'Count Alice');
  const a1 = await agent(app, alice.cookie, 'Alpha');
  const a2 = await agent(app, alice.cookie, 'Beta');
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/demo/start',
        headers: { ...headers, cookie: alice.cookie },
        payload: '{}',
      })
    ).statusCode,
    200,
  );
  const anon = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: '198.51.100.9',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'count-anon' },
        spec: { capabilities: ['research'], runtime: { mode: 'external' } },
      },
      idempotency_key: randomUUID(),
    }),
  });
  assert.equal(anon.statusCode, 201, anon.body);
  nextDay();
  const day2 = (await log.checkpoint()).checkpoint;
  assert.equal(day2.tree_size, 3, 'the demo seed is not counted');
  assert.deepEqual(day2.subcounts, {
    in_person_accounts: 2,
    in_ai_workspaces: 0,
    unclaimed: 1,
    revoked: 0,
  });
  assert.equal(day2.prev_hash, first.checkpoint.hash);
  assert.ok(day2.signature);
  assert.equal(await verifyCheckpointSignature(day2.hash, day2.signature!.sig, jwk), true);

  // Day 3: the anonymous agent is claimed (same id): no new leaf, the sub-counts move.
  const claim = await app.inject({
    method: 'POST',
    url: '/api/agents/claim',
    headers: { ...headers, cookie: alice.cookie },
    payload: JSON.stringify({ claim_token: anon.json().claim.claim_token }),
  });
  assert.equal(claim.statusCode, 200, claim.body);
  nextDay();
  const day3 = (await log.checkpoint()).checkpoint;
  assert.equal(day3.tree_size, 3);
  assert.equal(day3.subcounts.in_person_accounts, 3);
  assert.equal(day3.subcounts.unclaimed, 0);

  // Day 4: an agent removed from the app (the manual purge path) is withdrawn, never erased.
  await app.city.db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}',
       (SELECT jsonb_agg(a) FROM jsonb_array_elements(data->'agents') a WHERE a->>'id' <> $2))
     WHERE operator_id=$1`,
    [alice.id, a2],
  );
  nextDay();
  const day4 = (await log.checkpoint()).checkpoint;
  assert.equal(day4.tree_size, 3, 'the log only grows');
  assert.equal(day4.withdrawn, 1);
  assert.equal(day4.tree_size - day4.withdrawn, 2, 'the headline number');
  assert.deepEqual(
    (await log.withdrawn()).map((w) => w.reason),
    ['no_longer_counted'],
  );

  // The whole public history verifies: hashes, links, sub-counts, append-only proofs.
  const all = await log.checkpoints();
  assert.deepEqual(
    all.map((cp) => cp.date),
    ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'],
  );
  assert.deepEqual(await verifyChain(all), []);

  // The public leaves reproduce the published root.
  const page = await log.leaves(0, 100);
  assert.equal(page.tree_size, 3);
  assert.equal(toHex(await merkleRoot(page.leaves.map((l) => fromHex(l.leaf_hash)))), day4.root);

  // The owner proof: verifiable in isolation, only for the owner.
  const mine = await log.ownerProof(alice.id, a1);
  assert.ok(mine && 'proof' in mine);
  assert.deepEqual(await verifyAgentProof(a1, mine.proof, day4), { ok: true });
  const bob = await owner(app, 'Count Bob');
  assert.equal(await log.ownerProof(bob.id, a1), null, 'not yours');
  assert.equal(await log.ownerProof(alice.id, randomUUID()), null, 'does not exist');
  const late = await agent(app, alice.cookie, 'Gamma');
  assert.deepEqual(await log.ownerProof(alice.id, late), { pending: true }, 'next checkpoint');
});

test('the log is append-only in the database itself', async (t) => {
  const { app, log, nextDay } = await fixture(t);
  const person = await owner(app, 'Count Carol');
  const delta = await agent(app, person.cookie, 'Delta');
  nextDay();
  await log.checkpoint();
  // One withdrawn row too, so every table has rows to refuse changing.
  await app.city.db.query(
    `UPDATE workspaces SET data = jsonb_set(data, '{agents}', '[]'::jsonb) WHERE operator_id=$1`,
    [person.id],
  );
  nextDay();
  await log.checkpoint();
  assert.equal((await log.withdrawn()).length, 1, delta);
  for (const sql of [
    'UPDATE count_log_leaves SET created_day=created_day',
    'DELETE FROM count_log_leaves',
    'TRUNCATE count_log_leaves CASCADE',
    'UPDATE count_log_checkpoints SET tree_size=tree_size+1',
    'DELETE FROM count_log_checkpoints',
    'TRUNCATE count_log_checkpoints',
    'DELETE FROM count_log_withdrawn',
  ])
    await assert.rejects(app.city.db.query(sql), /append-only/, sql);
  assert.equal((await log.checkpoints()).length, 2);
});

test('public responses reveal no ids, names or salts; routes cache and guard the cron', async (t) => {
  const { app, log, nextDay } = await fixture(t);
  const dana = await owner(app, 'Count Dana');
  const ids = [
    await agent(app, dana.cookie, 'Echo Secret Name'),
    await agent(app, dana.cookie, 'Fox'),
  ];
  nextDay();

  const api = Fastify();
  t.after(() => api.close());
  registerCountLogRoutes(api, {
    log,
    cronSecret: 'a-sufficiently-long-cron-secret',
    owner: async (request) => {
      if (request.headers['x-test-owner'] !== dana.id)
        throw Object.assign(new Error('no'), { statusCode: 401 });
      return { id: dana.id, name: 'Count Dana' } as Operator;
    },
  });
  // The cron endpoint answers 404 without the exact bearer secret.
  for (const auth of [undefined, 'Bearer wrong', 'Bearer a-sufficiently-long-cron-secreT'])
    assert.equal(
      (
        await api.inject({
          url: '/api/cron/count-checkpoint',
          headers: auth ? { authorization: auth } : {},
        })
      ).statusCode,
      404,
    );
  const cron = await api.inject({
    url: '/api/cron/count-checkpoint',
    headers: { authorization: 'Bearer a-sufficiently-long-cron-secret' },
  });
  assert.equal(cron.statusCode, 200);
  assert.equal(cron.json().tree_size, 2);
  const date = cron.json().date as string;

  const bodies: string[] = [];
  const list = await api.inject({ url: '/api/public/count-log/checkpoints' });
  assert.match(String(list.headers['cache-control']), /s-maxage=300/);
  bodies.push(list.body);
  const one = await api.inject({ url: `/api/public/count-log/checkpoints/${date}` });
  assert.match(String(one.headers['cache-control']), /immutable/);
  bodies.push(one.body);
  const leaves = await api.inject({ url: '/api/public/count-log/leaves?from=0&to=2' });
  assert.equal(leaves.json().leaves.length, 2);
  assert.match(String(leaves.headers['cache-control']), /immutable/);
  bodies.push(leaves.body);
  bodies.push((await api.inject({ url: '/api/public/count-log/withdrawn' })).body);
  assert.equal(
    (await api.inject({ url: '/api/public/count-log/checkpoints/2020-01-01' })).statusCode,
    404,
  );
  // An invalid date is refused (400 in the app, whose error handler maps validation errors).
  assert.ok(
    (await api.inject({ url: '/api/public/count-log/checkpoints/nope' })).statusCode >= 400,
  );

  const salts = (
    await app.city.db.query<{ salt: Uint8Array }>('SELECT salt FROM count_log_leaves')
  ).rows.map((row) => toHex(new Uint8Array(row.salt)));
  for (const body of bodies)
    for (const secret of [...ids, dana.id, 'Echo Secret Name', 'Count Dana', ...salts])
      assert.ok(!body.includes(secret), `public response leaks ${secret.slice(0, 12)}…`);
  // Days only: no timestamps finer than a day in public responses.
  for (const body of bodies) assert.doesNotMatch(body, /T\d{2}:\d{2}/);

  // The owner route: only for the signed-in owner, and never cacheable.
  const proof = await api.inject({
    url: `/api/agents/${ids[0]}/count-proof`,
    headers: { 'x-test-owner': dana.id },
  });
  assert.equal(proof.statusCode, 200);
  assert.equal(proof.headers['cache-control'], 'private, no-store');
  assert.equal(proof.json().pending, false);
  assert.equal((await api.inject({ url: `/api/agents/${ids[0]}/count-proof` })).statusCode, 401);
  assert.equal(
    (
      await api.inject({
        url: `/api/agents/${randomUUID()}/count-proof`,
        headers: { 'x-test-owner': dana.id },
      })
    ).statusCode,
    404,
  );
});

test('an empty log has the RFC 6962 empty root', async (t) => {
  const { log } = await fixture(t);
  const { checkpoint } = await log.checkpoint();
  assert.equal(checkpoint.root, toHex(await merkleRoot([])));
  assert.equal(checkpoint.tree_size, 0);
});

test('the witness target is configurable and defaults to centralcity-ai/transparency', async () => {
  const { parseWitnessTarget, witnessFile } = await import('../server/count-log/index.js');
  assert.deepEqual(parseWitnessTarget(undefined), {
    repo: 'centralcity-ai/transparency',
    folder: 'agent-count',
  });
  assert.deepEqual(parseWitnessTarget('repo:centralcity-ai/other'), {
    repo: 'centralcity-ai/other',
    folder: 'agent-count',
  });
  assert.deepEqual(parseWitnessTarget('folder:centralcity-ai/protocol/witness/agent-count'), {
    repo: 'centralcity-ai/protocol',
    folder: 'witness/agent-count',
  });
  for (const bad of [
    'repo:',
    'repo:a',
    'folder:centralcity-ai/protocol/../x',
    'http://x',
    'folder:a/b',
  ])
    assert.throws(() => parseWitnessTarget(bad), /CITY_COUNT_WITNESS/, bad);
  const file = witnessFile(parseWitnessTarget(undefined), {
    v: 1,
    date: '2026-10-02',
    tree_size: 5,
    withdrawn: 1,
    root: 'ab'.repeat(32),
    prev_hash: null,
    subcounts: { in_person_accounts: 2, in_ai_workspaces: 1, unclaimed: 1, revoked: 0 },
    hash: 'cd'.repeat(32),
    signature: null,
    consistency: [],
  });
  assert.equal(file.path, 'agent-count/2026/2026-10-02.json');
  assert.equal(file.repo, 'centralcity-ai/transparency');
  assert.match(file.message, /4 agents/);
  assert.ok(file.content.endsWith('\n'));
});

test('wired into the app: public routes, the owner route and the cron behind CRON_SECRET', async (t) => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'wired-cron-secret-0123456789';
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const erin = await owner(app, 'Count Erin');
  const id = await agent(app, erin.cookie, 'Golf');
  assert.deepEqual((await app.inject({ url: '/api/public/count-log/checkpoints' })).json(), {
    checkpoints: [],
  });
  assert.equal((await app.inject({ url: '/api/cron/count-checkpoint' })).statusCode, 404);
  const cron = await app.inject({
    url: '/api/cron/count-checkpoint',
    headers: { authorization: 'Bearer wired-cron-secret-0123456789' },
  });
  assert.equal(cron.statusCode, 200, cron.body);
  assert.equal(cron.json().tree_size, 1);
  const { checkpoints } = (await app.inject({ url: '/api/public/count-log/checkpoints' })).json();
  assert.equal(checkpoints.length, 1);
  // Only an optional ?after=<day>: any other query string is refused, not a new cache entry.
  const after = await app.inject({ url: '/api/public/count-log/checkpoints?after=2026-09-28' });
  assert.equal(after.statusCode, 200);
  assert.deepEqual(after.json(), { checkpoints });
  for (const query of ['?x=1', '?after=tomorrow', '?after=2026-09-28&x=1', '?after='])
    assert.equal(
      (await app.inject({ url: `/api/public/count-log/checkpoints${query}` })).statusCode,
      400,
      query,
    );
  assert.ok(checkpoints[0].signature, 'signed with the platform key');
  // The checkpoint signature verifies with the key published in the JWKS.
  const jwks = (await app.inject({ url: '/.well-known/jwks.json' })).json() as {
    keys: { kid: string; kty: string; crv: string; x: string }[];
  };
  const key = jwks.keys.find((k) => k.kid === checkpoints[0].signature.kid)!;
  assert.ok(key, 'the signing key is in the JWKS');
  assert.equal(
    await verifyCheckpointSignature(checkpoints[0].hash, checkpoints[0].signature.sig, key),
    true,
  );
  // Owner route through the real session: yours verifies, signed out is refused.
  const proof = await app.inject({
    url: `/api/agents/${id}/count-proof`,
    headers: { cookie: erin.cookie },
  });
  assert.equal(proof.statusCode, 200, proof.body);
  assert.deepEqual(await verifyAgentProof(id, proof.json().proof, checkpoints[0]), { ok: true });
  assert.equal((await app.inject({ url: `/api/agents/${id}/count-proof` })).statusCode, 401);
  assert.equal(
    (await app.inject({ url: '/api/public/count-log/checkpoints/nope' })).statusCode,
    400,
  );
});

test('owner proofs read one cached tree per checkpoint', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  let now = Date.parse('2026-10-01T00:10:00Z');
  let leafReads = 0;
  const db = {
    ...app.city.db,
    query: ((sql: string, params?: unknown[]) => {
      if (/SELECT leaf_hash FROM count_log_leaves/.test(sql)) leafReads++;
      return app.city.db.query(sql, params as never);
    }) as typeof app.city.db.query,
    transaction: app.city.db.transaction.bind(app.city.db),
  };
  const log = createCountLog({ db, clock: () => now });
  const frank = await owner(app, 'Count Frank');
  const ids = [];
  for (const name of ['H1', 'H2', 'H3', 'H4', 'H5']) ids.push(await agent(app, frank.cookie, name));
  await log.checkpoint();
  const reads = leafReads;
  const day1 = (await log.checkpoints()).at(-1)!;
  for (const id of ids) {
    const result = await log.ownerProof(frank.id, id);
    assert.ok(result && 'proof' in result);
    assert.deepEqual(await verifyAgentProof(id, result.proof, day1), { ok: true });
  }
  assert.equal(leafReads - reads, 1, 'five proofs, one leaf read');
  // A new checkpoint builds the new tree once.
  ids.push(await agent(app, frank.cookie, 'H6'));
  now += DAY;
  await log.checkpoint();
  const day2 = (await log.checkpoints()).at(-1)!;
  const before = leafReads;
  for (const id of ids) {
    const result = await log.ownerProof(frank.id, id);
    assert.ok(result && 'proof' in result);
    assert.deepEqual(await verifyAgentProof(id, result.proof, day2), { ok: true });
  }
  assert.equal(leafReads - before, 1);
});

test('the owner proof route is rate limited per owner', async (t) => {
  const saved = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'limit-cron-secret-0123456789';
  t.after(() => {
    if (saved === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = saved;
  });
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const gina = await owner(app, 'Count Gina');
  const id = await agent(app, gina.cookie, 'India');
  await app.inject({
    url: '/api/cron/count-checkpoint',
    headers: { authorization: 'Bearer limit-cron-secret-0123456789' },
  });
  const ask = () =>
    app.inject({ url: `/api/agents/${id}/count-proof`, headers: { cookie: gina.cookie } });
  for (let i = 0; i < 10; i++) assert.equal((await ask()).statusCode, 200);
  const limited = await ask();
  assert.equal(limited.statusCode, 429);
  // Another owner is unaffected.
  const hank = await owner(app, 'Count Hank');
  const other = await app.inject({
    url: `/api/agents/${id}/count-proof`,
    headers: { cookie: hank.cookie },
  });
  assert.equal(other.statusCode, 404);
});

test('vercel.json runs the checkpoint once a day at 00:10 UTC, on a route the app serves', async () => {
  const { readFileSync } = await import('node:fs');
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons?: { path: string; schedule: string }[];
    rewrites: { source: string; destination: string }[];
  };
  assert.ok(
    config.crons?.some(
      (cron) => cron.path === '/api/cron/count-checkpoint' && cron.schedule === '10 0 * * *',
    ),
  );
  // /api/* reaches the function through the existing rewrite.
  assert.ok(config.rewrites.some((r) => r.source === '/api/:path*' && r.destination === '/api'));
});

test('agents the count never includes are told so, not promised a checkpoint', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const ivy = await owner(app, 'Count Ivy');
  await app.inject({
    method: 'POST',
    url: '/api/demo/start',
    headers: { ...headers, cookie: ivy.cookie },
    payload: '{}',
  });
  const snapshot = (
    await app.inject({ url: '/api/snapshot', headers: { cookie: ivy.cookie } })
  ).json() as { agents: { id: string; name: string }[] };
  const demo = snapshot.agents[0]!;
  const log = createCountLog({ db: app.city.db, clock: () => Date.parse('2026-10-01T00:10:00Z') });
  await log.checkpoint();
  assert.deepEqual(await log.ownerProof(ivy.id, demo.id), { pending: false, excluded: 'demo' });
  const test_ = createCountLog({
    db: app.city.db,
    clock: () => Date.parse('2026-10-01T00:10:00Z'),
    excludedOperators: [ivy.id],
  });
  const own = await agent(app, ivy.cookie, 'Juliet');
  assert.deepEqual(await test_.ownerProof(ivy.id, own), {
    pending: false,
    excluded: 'not_counted',
  });
});

test('the verify page lists an owner’s agents without touching the workspace', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const kim = await owner(app, 'Count Kim');
  const a = await agent(app, kim.cookie, 'Kilo');
  const b = await agent(app, kim.cookie, 'Lima');
  const before = (
    await app.city.db.query<{ data: unknown }>('SELECT data FROM workspaces WHERE operator_id=$1', [
      kim.id,
    ])
  ).rows[0]!.data;
  const res = await app.inject({
    url: '/api/count-log/my-agents',
    headers: { cookie: kim.cookie },
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  assert.deepEqual(res.json(), {
    agents: [
      { id: a, name: 'Kilo' },
      { id: b, name: 'Lima' },
    ],
  });
  const after = (
    await app.city.db.query<{ data: unknown }>('SELECT data FROM workspaces WHERE operator_id=$1', [
      kim.id,
    ])
  ).rows[0]!.data;
  assert.deepEqual(after, before, 'no workspace write');
  assert.equal((await app.inject({ url: '/api/count-log/my-agents' })).statusCode, 401);
});
