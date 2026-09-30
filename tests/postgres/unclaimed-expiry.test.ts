import { createApp } from '../../server/app.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { postgresDatabase } from '../../server/database.js';
import { runMigrations } from '../../server/migrations.js';
import { UNCLAIMED_AGENT_TTL_MS } from '../../server/autonomy/expiry-schema.js';
import { reconcile } from '../../server/autonomy/admin.js';

// Explicit opt-in, loopback-only disposable database. Never accepts a hosted URL.
const connection = process.env.CITY_EXPIRY_PG_TEST_URL;
const now = Date.parse('2026-09-30T00:00:00Z');
const scopeKeys = [
  'global',
  `site:${'a'.repeat(32)}`,
  `network:${'b'.repeat(32)}`,
  `region:${'c'.repeat(32)}`,
];
function validateConnection(value: string) {
  const url = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol), 'PostgreSQL protocol required');
  assert.equal(url.search, '', 'Connection query overrides are forbidden');
  assert.equal(url.hash, '', 'Connection fragments are forbidden');
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname), 'Only loopback test databases allowed');
  assert.equal(url.pathname, '/cc_expiry_synthetic', 'Requires dedicated synthetic database');
}
test('PostgreSQL harness refuses endpoint and schema overrides before connecting', () => {
  const safe = 'postgresql://cc_test@127.0.0.1:55439/cc_expiry_synthetic';
  assert.doesNotThrow(() => validateConnection(safe));
  for (const invalid of [
    safe + '?host=remote.example',
    safe + '?options=-csearch_path=public',
    safe + '#fragment',
    safe.replace('127.0.0.1', 'remote.example'),
    safe.replace('cc_expiry_synthetic', 'production'),
    safe.replace('postgresql:', 'https:'),
  ])
    assert.throws(() => validateConnection(invalid));
});
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  assert.ok(connection, 'Set CITY_EXPIRY_PG_TEST_URL explicitly');
  validateConnection(connection);
  const admin = new Pool({ connectionString: connection, max: 2 });
  const schema = `expiry_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new Pool({
    connectionString: connection,
    max: 8,
    options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=6000`,
  });
  const db = postgresDatabase(pool);
  t.after(async () => {
    try {
      await db.close();
    } finally {
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  await runMigrations(db, undefined, () => now, true);
  const seed = async (
    n: number,
    indexed = true,
    createdAt = new Date(now - UNCLAIMED_AGENT_TTL_MS).toISOString(),
  ) => {
    const id = `owner-${String(n).padStart(4, '0')}`;
    const agent = `agent-${String(n).padStart(4, '0')}`;
    await db.query(
      "INSERT INTO operators(id,name,name_key,password_hash,salt,kind) VALUES($1,$1,$1,'synthetic','synthetic','unclaimed')",
      [id],
    );
    await db.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
      id,
      JSON.stringify({
        paused: false,
        agents: [{ id: agent, createdAt }],
        jobs: [],
        connections: [],
        events: [],
      }),
    ]);
    await db.query(
      'INSERT INTO unclaimed_buckets(operator_id,site_key,network_key,region_key,created_at) VALUES($1,$2,$3,$4,$5)',
      [id, 'a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), now],
    );
    if (indexed)
      await db.query('INSERT INTO unclaimed_agent_expiry VALUES($1,$2,$3)', [agent, id, now]);
    for (const scope of scopeKeys)
      await db.query(
        'INSERT INTO unclaimed_stats(scope_key,agents,buckets) VALUES($1,1,$2) ON CONFLICT(scope_key) DO UPDATE SET agents=unclaimed_stats.agents+1,buckets=unclaimed_stats.buckets+EXCLUDED.buckets',
        [scope, scope === 'global' ? 1 : 0],
      );
    return { id, agent };
  };
  return { db, pool, seed };
}

test(
  'real PostgreSQL non-destructive anonymous capacity',
  { skip: !connection, timeout: 90000 },
  async (t) => {
    await t.test('concurrent HTTP admissions cannot oversubscribe a global cap', async (t) => {
      const { db } = await fixture(t);
      const previous = process.env.CITY_RATE_LIMIT_KEY;
      process.env.CITY_RATE_LIMIT_KEY = 'synthetic-local-postgres-test-key-only';
      const app = await createApp({
        database: { ...db, close: async () => {} },
        startWorkers: false,
        now: () => now,
        hosted: {
          databaseUrl: connection!,
          publicOrigin: 'https://city.test',
          allowedOrigins: ['https://city.test'],
        },
        limits: { unclaimedAgentsGlobal: 3 },
        logLine: () => {},
      });
      try {
        const results = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            app.inject({
              method: 'POST',
              url: '/api/public/agents',
              headers: { host: 'city.test' },
              remoteAddress: `198.51.${i}.1`,
              payload: {
                manifest: {
                  apiVersion: 'centralcity.agent/v1',
                  kind: 'Agent',
                  metadata: { name: `parallel-${i}` },
                  spec: { capabilities: ['research'], runtime: { mode: 'external' } },
                },
                idempotency_key: randomUUID(),
              },
            }),
          ),
        );
        assert.equal(results.filter((r) => r.statusCode === 201).length, 3);
        assert.ok(results.every((r) => r.statusCode !== 500));
        const row = (
          await db.query<{ agents: string }>(
            "SELECT agents FROM unclaimed_stats WHERE scope_key='global'",
          )
        ).rows[0]!;
        assert.equal(Number(row.agents), 3);
        assert.equal((await db.query('SELECT * FROM unclaimed_agent_expiry')).rows.length, 3);
        assert.equal(
          (await db.query("SELECT * FROM unclaimed_stats WHERE scope_key LIKE 'hold:%'")).rows
            .length,
          0,
        );
        assert.deepEqual((await reconcile(db, { confirm: false, now })).agents, []);
      } finally {
        try {
          await app.close();
        } finally {
          if (previous === undefined) delete process.env.CITY_RATE_LIMIT_KEY;
          else process.env.CITY_RATE_LIMIT_KEY = previous;
        }
      }
    });
  },
);
