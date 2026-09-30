import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import { fixture, ownerApi, type App } from './oauth-helpers.js';
import { sweepUnclaimedAgents } from '../server/autonomy/expiry.js';
import {
  UNCLAIMED_AGENT_TTL_MS,
  unclaimedExpiryMigration,
} from '../server/autonomy/expiry-schema.js';
import { reconcile, purge } from '../server/autonomy/admin.js';

const start = Date.parse('2026-09-27T00:00:00Z');
async function create(app: App, name: string, address = '192.0.2.1') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: address,
    payload: {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name },
        spec: { capabilities: ['research'], runtime: { mode: 'external' } },
      },
      idempotency_key: randomUUID(),
    },
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}
async function ids(app: App) {
  return (
    await app.city.db.query<{ id: string }>(
      "SELECT a->>'id' AS id FROM workspaces w CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a",
    )
  ).rows.map((row) => row.id);
}

test('old agents survive new admission and confirmed reconciliation', async (t) => {
  let now = start;
  const { app } = await fixture(t, { clock: () => now });
  const old = await create(app, 'old');
  now += 365 * 86400000;
  const fresh = await create(app, 'fresh');
  await reconcile(app.city.db, { confirm: true, now });
  assert.deepEqual(new Set(await ids(app)), new Set([old.agent.id, fresh.agent.id]));
  assert.equal(
    (await app.city.db.query('SELECT * FROM agent_manifests WHERE agent_id=$1', [old.agent.id]))
      .rows.length,
    1,
  );
  assert.deepEqual(await sweepUnclaimedAgents(app.city.db, now), { examined: 0, removed: 0 });
  assert.deepEqual(new Set(await ids(app)), new Set([old.agent.id, fresh.agent.id]));
});
test('full capacity refuses admission without deleting the old agent', async (t) => {
  let now = start;
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    now: () => now,
    limits: { unclaimedAgentsGlobal: 1, unclaimedAgentsPerSource: 1 },
  });
  t.after(() => app.close());
  const old = await create(app, 'at-cap');
  now += 365 * 86400000;
  const denied = await app.inject({
    method: 'POST',
    url: '/api/public/agents',
    remoteAddress: '192.0.2.1',
    payload: {
      manifest: {
        apiVersion: 'centralcity.agent/v1',
        kind: 'Agent',
        metadata: { name: 'new' },
        spec: { capabilities: ['research'], runtime: { mode: 'external' } },
      },
      idempotency_key: randomUUID(),
    },
  });
  assert.equal(denied.statusCode, 409, denied.body);
  assert.deepEqual(await ids(app), [old.agent.id]);
  assert.equal(
    Number(
      (
        await app.city.db.query<{ agents: number }>(
          "SELECT agents FROM unclaimed_stats WHERE scope_key='global'",
        )
      ).rows[0]!.agents,
    ),
    1,
  );
});
test('old agent can be claimed with a still-valid token', async (t) => {
  let now = start;
  const { app, cookie } = await fixture(t, { clock: () => now });
  const old = await create(app, 'claim-old');
  now += 365 * 86400000;
  await app.city.db.query('UPDATE sessions SET expires_at=$1', [now + 60000]);
  const claim = await ownerApi(app, cookie, '/api/agents/claim', {
    claim_token: old.claim.claim_token,
  });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.deepEqual(await ids(app), [old.agent.id]);
});
test('compatibility sweep performs no database reads or writes', async () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('sweep touched database');
      },
    },
  ) as Parameters<typeof sweepUnclaimedAgents>[0];
  assert.deepEqual(await sweepUnclaimedAgents(db, Date.now()), { examined: 0, removed: 0 });
});

test('manual purge cascades expiry rows and cannot leave due work behind', async (t) => {
  const { app } = await fixture(t, { clock: () => start });
  const a = await create(app, 'purged');
  const row = (
    await app.city.db.query<{ operator_id: string }>(
      'SELECT operator_id FROM unclaimed_agent_expiry WHERE agent_id=$1',
      [a.agent.id],
    )
  ).rows[0]!;
  assert.deepEqual(await purge(app.city.db, { partition: row.operator_id }, ''), {
    partitions: 1,
    agents: 1,
  });
  assert.equal((await app.city.db.query('SELECT * FROM unclaimed_agent_expiry')).rows.length, 0);
});

test('migration backfills existing unclaimed agents by individual creation time, excluding claimed agents', async (t) => {
  let now = start;
  const { app, cookie } = await fixture(t, { clock: () => now });
  const first = await create(app, 'legacy-old');
  now += 1000;
  const second = await create(app, 'legacy-young');
  const claimed = await create(app, 'legacy-owned');
  assert.equal(
    (await ownerApi(app, cookie, '/api/agents/claim', { claim_token: claimed.claim.claim_token }))
      .statusCode,
    200,
  );
  await app.city.db.query('DELETE FROM unclaimed_agent_expiry');
  await app.city.db.exec(unclaimedExpiryMigration.sql);
  const rows = (
    await app.city.db.query<{ agent_id: string; expires_at: string }>(
      'SELECT agent_id,expires_at FROM unclaimed_agent_expiry ORDER BY expires_at',
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [r.agent_id, Number(r.expires_at)]),
    [
      [first.agent.id, start + UNCLAIMED_AGENT_TTL_MS],
      [second.agent.id, now + UNCLAIMED_AGENT_TTL_MS],
    ],
  );
});

test('reconcile repairs missing rollout expiry rows only when confirmed and preserves existing deadlines', async (t) => {
  const { app } = await fixture(t, { clock: () => start });
  const missing = await create(app, 'old-instance');
  const existing = await create(app, 'new-instance');
  await app.city.db.query('DELETE FROM unclaimed_agent_expiry WHERE agent_id=$1', [
    missing.agent.id,
  ]);
  const deferred = start + UNCLAIMED_AGENT_TTL_MS + 60_000;
  await app.city.db.query('UPDATE unclaimed_agent_expiry SET expires_at=$2 WHERE agent_id=$1', [
    existing.agent.id,
    deferred,
  ]);
  const dry = await reconcile(app.city.db, { confirm: false, now: start });
  assert.deepEqual(dry.expiry_index, {
    missing: 1,
    repaired: 0,
    invalid_dates: 0,
    batch_limit: 100,
  });
  assert.equal(
    (
      await app.city.db.query('SELECT agent_id FROM unclaimed_agent_expiry WHERE agent_id=$1', [
        missing.agent.id,
      ])
    ).rows.length,
    0,
  );
  const applied = await reconcile(app.city.db, { confirm: true, now: start });
  assert.equal(applied.expiry_index.repaired, 1);
  const rows = await app.city.db.query<{ agent_id: string; expires_at: string }>(
    'SELECT agent_id,expires_at FROM unclaimed_agent_expiry',
  );
  assert.equal(
    Number(rows.rows.find((r) => r.agent_id === missing.agent.id)!.expires_at),
    start + UNCLAIMED_AGENT_TTL_MS,
  );
  assert.equal(
    Number(rows.rows.find((r) => r.agent_id === existing.agent.id)!.expires_at),
    deferred,
  );
  assert.equal(
    (await reconcile(app.city.db, { confirm: true, now: start })).expiry_index.repaired,
    0,
  );
});
