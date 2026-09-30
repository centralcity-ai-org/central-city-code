import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import type { Pool, PoolConfig } from 'pg';
import { NeonLoadError, withDisposableNeon } from '../scripts/neon-load/index.js';

const directHost = 'ep-safe-branch-123.us-east-2.aws.neon.tech';
const poolerHost = 'ep-safe-branch-123-pooler.us-east-2.aws.neon.tech';
const input = {
  databaseUrl: `postgresql://loader:synthetic%40secret@${directHost}/city?sslmode=verify-full`,
  disposableEndpoint: poolerHost,
  forbiddenEndpoints: ['ep-production-123', 'ep-staging-123.us-west-2.aws.neon.tech'],
};

type QueryHandler = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;
interface FakePool {
  config: PoolConfig;
  queries: { sql: string; params?: unknown[] }[];
  ended: number;
  errors: ((error: Error) => void)[];
  query: QueryHandler;
  end(): Promise<void>;
  on(event: string, callback: (error: Error) => void): void;
}

function fakePools(
  handler: (
    config: PoolConfig,
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Record<string, unknown>[] }>,
) {
  const pools: FakePool[] = [];
  const poolFactory = (config: PoolConfig) => {
    const pool: FakePool = {
      config,
      queries: [],
      ended: 0,
      errors: [],
      query: async (sql, params) => {
        pool.queries.push({ sql, params });
        return handler(config, sql, params);
      },
      end: async () => {
        pool.ended++;
      },
      on: (_event, callback) => pool.errors.push(callback),
    };
    pools.push(pool);
    return pool as unknown as Pool;
  };
  return { pools, poolFactory };
}

const emptyDbHandler = async (_config: PoolConfig, sql: string) => {
  if (sql.includes('pg_catalog.pg_class'))
    return {
      rows: [{ custom_schema_count: 0, relation_count: 0, function_count: 0, type_count: 0 }],
    };
  if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
  if (sql.includes('pg_stat_activity')) return { rows: [] };
  if (sql.includes('pg_locks')) return { rows: [] };
  throw new Error('Unexpected synthetic query');
};

async function expectCode(action: () => Promise<unknown>, code: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof NeonLoadError);
    assert.equal(error.code, code);
    return true;
  });
}

test('rejects unsafe endpoints, aliases, denylist entries, and query overrides before creating pools', async () => {
  const { pools, poolFactory } = fakePools(async () => ({ rows: [] }));
  const dependency = { poolFactory };
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, disposableEndpoint: 'ep-other.us-east-2.aws.neon.tech' },
        async () => 0,
        dependency,
      ),
    'ENDPOINT_MISMATCH',
  );
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, forbiddenEndpoints: ['ep-safe-branch-123-pooler.eu-central-1.aws.neon.tech'] },
        async () => 0,
        dependency,
      ),
    'FORBIDDEN_ENDPOINT',
  );
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, forbiddenEndpoints: ['not-a-neon-host'] },
        async () => 0,
        dependency,
      ),
    'INVALID_FORBIDDEN_ENDPOINT',
  );
  await expectCode(
    () => withDisposableNeon({ ...input, forbiddenEndpoints: [] }, async () => 0, dependency),
    'INVALID_CONFIGURATION',
  );
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, databaseUrl: `${input.databaseUrl}&host=attacker.example` },
        async () => 0,
        dependency,
      ),
    'INVALID_CONFIGURATION',
  );
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, databaseUrl: `${input.databaseUrl}&sslmode=disable` },
        async () => 0,
        dependency,
      ),
    'INVALID_CONFIGURATION',
  );
  await expectCode(
    () =>
      withDisposableNeon(
        { ...input, databaseUrl: input.databaseUrl.replace('/city?', ':5433/city?') },
        async () => 0,
        dependency,
      ),
    'INVALID_CONFIGURATION',
  );
  assert.equal(pools.length, 0);
});

test('normalizes direct/pooler aliases and gives pg explicit verified TLS connection fields', async () => {
  const { pools, poolFactory } = fakePools(emptyDbHandler);
  const result = await withDisposableNeon(input, async ({ redactedTarget }) => redactedTarget, {
    poolFactory,
  });
  assert.equal(pools.length, 2);
  assert.equal(pools[0].config.host, directHost);
  assert.equal(pools[0].config.port, 5432);
  assert.equal(pools[0].config.user, 'loader');
  assert.equal(pools[0].config.password, 'synthetic@secret');
  assert.equal(pools[0].config.database, 'city');
  assert.deepEqual(pools[0].config.ssl, { rejectUnauthorized: true });
  assert.equal(pools[0].config.max, 3);
  assert.equal(pools[1].config.max, 1);
  assert.equal(pools[0].config.application_name, pools[1].config.application_name);
  assert.match(String(pools[0].config.application_name), /^cc-neon-[a-f0-9]{32}$/);
  assert.equal('connectionString' in pools[0].config, false);
  assert.equal(result.redactedTarget, 'postgresql://<redacted-disposable-neon-endpoint>');
  assert.equal(result.redactedTarget.includes('synthetic'), false);
  assert.equal(result.redactedTarget.includes('city'), false);
  assert.equal(result.sampler.sampleCount, 0);
  assert.deepEqual(
    pools.map((pool) => pool.ended),
    [1, 1],
  );
});

test('refuses relations, functions, types, or custom schemas before callback and closes app pool', async () => {
  for (const nonemptyField of [
    'relation_count',
    'function_count',
    'type_count',
    'custom_schema_count',
  ] as const) {
    const { pools, poolFactory } = fakePools(async (_config, sql) => {
      if (sql.includes('pg_catalog.pg_class'))
        return {
          rows: [
            {
              custom_schema_count: 0,
              relation_count: 0,
              function_count: 0,
              type_count: 0,
              [nonemptyField]: 1,
            },
          ],
        };
      throw new Error('Callback or sampler must not run');
    });
    let called = false;
    await expectCode(
      () =>
        withDisposableNeon(
          input,
          async () => {
            called = true;
          },
          { poolFactory },
        ),
      'DATABASE_NOT_EMPTY',
    );
    assert.equal(called, false);
    assert.equal(pools.length, 1);
    assert.equal(pools[0].ended, 1);
  }
});

test('runs catalog preflight against PGlite: fresh passes; user relations, schemas, functions, and types refuse', async () => {
  const makeFactory = (engine: PGlite) => (config: PoolConfig) => {
    const pool = {
      on: () => {},
      query: async (sql: string, params?: unknown[]) => {
        if (config.max === 1) {
          if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
          if (sql.includes('pg_stat_activity')) return { rows: [] };
          if (sql.includes('pg_locks')) return { rows: [] };
          throw new Error('Unexpected synthetic sampler query');
        }
        const result = await engine.query(sql, params as never[] | undefined);
        return { rows: result.rows as Record<string, unknown>[] };
      },
      end: async () => {},
    };
    return pool as unknown as Pool;
  };

  const fresh = new PGlite();
  try {
    let freshActionCalled = false;
    const freshResult = await withDisposableNeon(
      input,
      async () => {
        freshActionCalled = true;
        return 'fresh';
      },
      { poolFactory: makeFactory(fresh) },
    );
    assert.equal(freshActionCalled, true);
    assert.equal(freshResult.value, 'fresh');

    const objects = [
      ['CREATE TABLE public.user_table (id integer)', 'DROP TABLE public.user_table'],
      ['CREATE SCHEMA user_schema', 'DROP SCHEMA user_schema'],
      [
        "CREATE FUNCTION public.user_function() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
        'DROP FUNCTION public.user_function()',
      ],
      ["CREATE TYPE public.user_enum AS ENUM ('one', 'two')", 'DROP TYPE public.user_enum'],
      ['CREATE TYPE public.user_composite AS (value integer)', 'DROP TYPE public.user_composite'],
    ] as const;
    for (const [ddl, drop] of objects) {
      await fresh.exec(ddl);
      let called = false;
      await expectCode(
        () =>
          withDisposableNeon(
            input,
            async () => {
              called = true;
            },
            { poolFactory: makeFactory(fresh) },
          ),
        'DATABASE_NOT_EMPTY',
      );
      assert.equal(called, false, ddl);
      await fresh.exec(drop);
    }
  } finally {
    await fresh.close();
  }
});

test('sanitizes preflight failures and closes the pool without exposing driver errors', async () => {
  const secretError = 'password=synthetic-secret raw SQL SELECT private_data';
  const { pools, poolFactory } = fakePools(async () => {
    throw new Error(secretError);
  });
  let called = false;
  try {
    await withDisposableNeon(
      input,
      async () => {
        called = true;
      },
      { poolFactory },
    );
    assert.fail('expected a fixed preflight error');
  } catch (error) {
    assert.ok(error instanceof NeonLoadError);
    assert.equal(error.code, 'PREFLIGHT_QUERY_FAILED');
    assert.equal(String(error).includes(secretError), false);
  }
  assert.equal(called, false);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].ended, 1);
});

test('samples bounded aggregate wait and lock counts for its own app name without raw rows', async () => {
  const { pools, poolFactory } = fakePools(async (_config, sql) => {
    if (sql.includes('pg_catalog.pg_class'))
      return {
        rows: [{ custom_schema_count: 0, relation_count: 0, function_count: 0, type_count: 0 }],
      };
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (sql.includes('pg_locks'))
      return {
        rows: [
          { mode: 'AccessShareLock', granted: true, lock_count: 5 },
          { mode: 'RowExclusiveLock', granted: false, lock_count: 2 },
          { mode: 'secret-lock-mode', granted: true, lock_count: 3 },
        ],
      };
    if (sql.includes('pg_stat_activity'))
      return {
        rows: [
          { wait_event_type: 'Lock', state: 'active', connection_count: 2 },
          { wait_event_type: 'Client', state: 'idle', connection_count: 3 },
          { wait_event_type: null, state: null, connection_count: 1 },
          { wait_event_type: 'unrecognized', state: 'unrecognized state', connection_count: 4 },
        ],
      };
    throw new Error('Unexpected synthetic query');
  });
  const result = await withDisposableNeon(
    input,
    async ({ sampler }) => {
      sampler.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'finished';
    },
    { poolFactory },
  );
  assert.equal(result.value, 'finished');
  assert.equal(result.sampler.sampleCount, 1);
  assert.equal(result.sampler.sampleErrorCount, 0);
  assert.equal(result.sampler.waitConnectionObservations.Lock, 2);
  assert.equal(result.sampler.waitConnectionObservations.Client, 3);
  assert.equal(result.sampler.waitConnectionObservations.None, 1);
  assert.equal(result.sampler.waitConnectionObservations.Other, 4);
  assert.equal(result.sampler.stateConnectionObservations.Active, 2);
  assert.equal(result.sampler.stateConnectionObservations.Idle, 3);
  assert.equal(result.sampler.stateConnectionObservations.None, 1);
  assert.equal(result.sampler.stateConnectionObservations.Other, 4);
  assert.equal(result.sampler.lockObservationsByMode.AccessShareLock, 5);
  assert.equal(result.sampler.lockObservationsByMode.RowExclusiveLock, 2);
  assert.equal(result.sampler.lockObservationsByMode.Other, 3);
  assert.equal(result.sampler.maxLockCount, 10);
  assert.equal(result.sampler.maxWaitingLockCount, 2);
  assert.equal(result.sampler.rttMs.count, 1);
  assert.match(result.sampler.note, /occupancy counts, not duration/);
  const samplerPool = pools[1];
  const statQueries = samplerPool.queries.filter(
    ({ sql }) => sql.includes('pg_stat_activity') || sql.includes('pg_locks'),
  );
  assert.ok(statQueries.every(({ params }) => params?.[0] === pools[0].config.application_name));
  assert.ok(statQueries.every(({ sql }) => !/query\s+AS|query\s*,/.test(sql)));
  assert.ok(statQueries.some(({ sql }) => sql.includes('GROUP BY wait_event_type, state')));
  assert.ok(statQueries.some(({ sql }) => sql.includes('GROUP BY l.mode, l.granted')));
  assert.equal(JSON.stringify(result.sampler).includes('unrecognized'), false);
  assert.deepEqual(
    pools.map((pool) => pool.ended),
    [1, 1],
  );
});

test('stops sampler and closes both pools when the action fails', async () => {
  const { pools, poolFactory } = fakePools(emptyDbHandler);
  const secretError = 'synthetic-password-and-private-row';
  try {
    await withDisposableNeon(
      input,
      async ({ sampler }) => {
        sampler.start();
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error(secretError);
      },
      { poolFactory },
    );
    assert.fail('expected a fixed action error');
  } catch (error) {
    assert.ok(error instanceof NeonLoadError);
    assert.equal(error.code, 'ACTION_FAILED');
    assert.equal(String(error).includes(secretError), false);
  }
  assert.equal(pools.length, 2);
  assert.deepEqual(
    pools.map((pool) => pool.ended),
    [1, 1],
  );
  assert.ok(pools[1].queries.some(({ sql }) => sql === 'SELECT 1'));
});

test('concurrent stop calls share completion of the in-flight sample', async () => {
  let markPingStarted!: () => void;
  let releasePing!: () => void;
  const pingStarted = new Promise<void>((resolve) => {
    markPingStarted = resolve;
  });
  const { pools, poolFactory } = fakePools(async (_config, sql) => {
    if (sql.includes('pg_catalog.pg_class'))
      return {
        rows: [{ custom_schema_count: 0, relation_count: 0, function_count: 0, type_count: 0 }],
      };
    if (sql === 'SELECT 1') {
      await new Promise<void>((resolve) => {
        releasePing = resolve;
        markPingStarted();
      });
      return { rows: [{ '?column?': 1 }] };
    }
    if (sql.includes('pg_locks')) return { rows: [] };
    if (sql.includes('pg_stat_activity')) return { rows: [] };
    throw new Error('Unexpected synthetic query');
  });
  const result = await withDisposableNeon(
    input,
    async ({ sampler }) => {
      sampler.start();
      sampler.start();
      await pingStarted;
      const firstStop = sampler.stop();
      const secondStop = sampler.stop();
      assert.strictEqual(firstStop, secondStop);
      let done = false;
      void firstStop.then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(done, false);
      releasePing();
      const [first, second] = await Promise.all([firstStop, secondStop]);
      assert.strictEqual(first, second);
      return first.sampleCount;
    },
    { poolFactory },
  );
  assert.equal(result.value, 1);
  assert.equal(pools[1].ended, 1);
});

test('cleans up app pool if sampler pool creation fails and attempts both ends if cleanup fails', async () => {
  const first = fakePools(emptyDbHandler);
  let creations = 0;
  await expectCode(
    () =>
      withDisposableNeon(input, async () => 0, {
        poolFactory: (config) => {
          creations++;
          if (creations === 2) throw new Error('synthetic secret');
          return first.poolFactory(config);
        },
      }),
    'POOL_CREATE_FAILED',
  );
  assert.equal(first.pools.length, 1);
  assert.equal(first.pools[0].ended, 1);

  const closing = fakePools(emptyDbHandler);
  const baseFactory = closing.poolFactory;
  let samplerEndAttempted = false;
  await expectCode(
    () =>
      withDisposableNeon(input, async () => 0, {
        poolFactory: (config) => {
          const pool = baseFactory(config) as unknown as { end(): Promise<void> };
          if (config.max === 1)
            pool.end = async () => {
              samplerEndAttempted = true;
              throw new Error('synthetic close secret');
            };
          return pool as unknown as Pool;
        },
      }),
    'CLEANUP_FAILED',
  );
  assert.equal(samplerEndAttempted, true);
  assert.deepEqual(
    closing.pools.map((pool) => pool.ended),
    [1, 0],
  );
});

test('counts sampler query errors without exposing driver messages', async () => {
  const secret = 'synthetic connection password private row';
  const { pools, poolFactory } = fakePools(async (_config, sql) => {
    if (sql.includes('pg_catalog.pg_class'))
      return {
        rows: [{ custom_schema_count: 0, relation_count: 0, function_count: 0, type_count: 0 }],
      };
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
    if (sql.includes('pg_stat_activity')) throw new Error(secret);
    if (sql.includes('pg_locks')) return { rows: [] };
    throw new Error('Unexpected synthetic query');
  });
  const result = await withDisposableNeon(
    input,
    async ({ sampler }) => {
      sampler.start();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    },
    { poolFactory },
  );
  assert.equal(result.sampler.sampleCount, 0);
  assert.equal(result.sampler.sampleErrorCount, 1);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(
    pools.map((pool) => pool.ended),
    [1, 1],
  );
});
