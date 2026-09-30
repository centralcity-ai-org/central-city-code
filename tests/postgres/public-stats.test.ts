import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { postgresDatabase } from '../../server/database.js';
import {
  AI_AGENTS_TOTAL_SQL,
  PUBLIC_STATS_LEASE_MS,
  PUBLIC_STATS_TTL_MS,
  createPublicStats,
  sqlPublicStatsStore,
} from '../../server/stats/public-stats.js';
import { publicStatsMigration } from '../../server/stats/schema.js';

// Explicit opt-in, loopback-only disposable database (same harness rules as the other
// tests/postgres suites). Never accepts a hosted URL.
const connection = process.env.CITY_EXPIRY_PG_TEST_URL;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  assert.ok(connection);
  const url = new URL(connection);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/cc_expiry_synthetic');
  assert.equal(url.search, '');
  assert.equal(url.hash, '');
  const admin = new Pool({ connectionString: connection, max: 2 });
  const schema = `stats_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: connection,
    max: 8,
    options: `-c search_path=${schema} -c statement_timeout=10000`,
  });
  const db = postgresDatabase(pool);
  t.after(async () => {
    await db.close();
    try {
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await admin.end();
    }
  });
  await db.query('CREATE TABLE workspaces (operator_id text PRIMARY KEY, data jsonb NOT NULL)');
  await db.query(publicStatsMigration.sql);
  for (let i = 0; i < 3; i++)
    await db.query('INSERT INTO workspaces VALUES($1,$2::jsonb)', [
      `owner-${i}`,
      JSON.stringify({ agents: [{ id: `agent-${i}` }], jobs: [] }),
    ]);
  let counts = 0;
  const counted = {
    query: (async (sql: string, params?: unknown[]) => {
      if (sql === AI_AGENTS_TOTAL_SQL) counts++;
      return db.query(sql, params as never);
    }) as never,
  };
  return { db, counted, counts: () => counts };
}

test(
  'real PostgreSQL: shared public stats row',
  { skip: !connection, timeout: 60000 },
  async (t) => {
    await t.test('concurrent claims on a stale row: exactly one winner', async (t) => {
      const f = await fixture(t);
      const store = sqlPublicStatsStore(f.db);
      const now = 5_000_000;
      const wins = await Promise.all(
        Array.from({ length: 16 }, () =>
          store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS),
        ),
      );
      assert.equal(wins.filter(Boolean).length, 1);
    });

    await t.test('eight instances refreshing together run one aggregate per TTL', async (t) => {
      const f = await fixture(t);
      let now = 6_000_000;
      const store = sqlPublicStatsStore(f.db);
      // Seed a stored value so no instance takes the cold-start path.
      await store.claim('ai_agents_total', now, PUBLIC_STATS_TTL_MS, PUBLIC_STATS_LEASE_MS);
      await store.write('ai_agents_total', 3, now);
      const instances = Array.from({ length: 8 }, () =>
        createPublicStats({ clock: () => now, db: f.counted }),
      );
      for (let round = 0; round < 3; round++) {
        now += PUBLIC_STATS_TTL_MS;
        const before = f.counts();
        const values = await Promise.all(instances.map((x) => x.get()));
        assert.equal(f.counts() - before, 1, `round ${round}`);
        assert.ok(values.every((v) => v.ai_agents_total === 3));
      }
    });
  },
);
