import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import type { PoolConfig } from 'pg';
import { postgresDatabase } from '../../server/database.js';
import type { Database } from '../../server/database.js';

const DEFAULT_POOL_SIZE = 3;
const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const WAIT_TYPES = [
  'Activity',
  'BufferPin',
  'Client',
  'IO',
  'IPC',
  'LWLock',
  'Lock',
  'Timeout',
  'Other',
] as const;
const STATES = [
  'Active',
  'Idle',
  'IdleInTransaction',
  'IdleInTransactionAborted',
  'FastpathFunctionCall',
  'Disabled',
  'Other',
  'None',
] as const;
const LOCK_MODES = [
  'AccessShareLock',
  'RowShareLock',
  'RowExclusiveLock',
  'ShareUpdateExclusiveLock',
  'ShareLock',
  'ShareRowExclusiveLock',
  'ExclusiveLock',
  'AccessExclusiveLock',
  'SIReadLock',
  'Other',
] as const;
type WaitType = (typeof WAIT_TYPES)[number];
type StateType = (typeof STATES)[number];
type LockModeType = (typeof LOCK_MODES)[number];

export type NeonLoadErrorCode =
  | 'INVALID_CONFIGURATION'
  | 'INVALID_DISPOSABLE_ENDPOINT'
  | 'INVALID_FORBIDDEN_ENDPOINT'
  | 'FORBIDDEN_ENDPOINT'
  | 'ENDPOINT_MISMATCH'
  | 'POOL_CREATE_FAILED'
  | 'PREFLIGHT_QUERY_FAILED'
  | 'DATABASE_NOT_EMPTY'
  | 'ACTION_FAILED'
  | 'CLEANUP_FAILED';

const ERROR_MESSAGES: Record<NeonLoadErrorCode, string> = {
  INVALID_CONFIGURATION: 'Neon load configuration is invalid.',
  INVALID_DISPOSABLE_ENDPOINT: 'Disposable endpoint is not a valid Neon endpoint.',
  INVALID_FORBIDDEN_ENDPOINT: 'Forbidden endpoint list contains an invalid entry.',
  FORBIDDEN_ENDPOINT: 'Database endpoint is on the forbidden list.',
  ENDPOINT_MISMATCH: 'Database URL does not match the declared disposable endpoint.',
  POOL_CREATE_FAILED: 'Unable to create database connection pools.',
  PREFLIGHT_QUERY_FAILED: 'Disposable database preflight failed.',
  DATABASE_NOT_EMPTY: 'Disposable database contains user objects; use a fresh database branch.',
  ACTION_FAILED: 'Disposable database action failed.',
  CLEANUP_FAILED: 'Disposable database pool cleanup failed.',
};

export class NeonLoadError extends Error {
  readonly code: NeonLoadErrorCode;

  constructor(code: NeonLoadErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'NeonLoadError';
    this.code = code;
  }
}

export interface NeonLoadInput {
  /** Private input only; never copied to reports, errors, or logs. */
  databaseUrl: string;
  /** Endpoint host, endpoint id (ep-...), or PostgreSQL URL identifying the disposable branch. */
  disposableEndpoint: string;
  /** Hostnames, endpoint ids, or PostgreSQL URLs that must never be used. */
  forbiddenEndpoints: readonly string[];
  poolSize?: number;
  sampleIntervalMs?: number;
}

export interface NeonRttSummary {
  count: number;
  minMs: number | null;
  maxMs: number | null;
  meanMs: number | null;
}

export interface NeonSamplerSummary {
  sampleCount: number;
  sampleErrorCount: number;
  rttMs: NeonRttSummary;
  /** Sum of sampled connection counts by fixed PostgreSQL wait-event category. */
  waitConnectionObservations: Record<WaitType | 'None', number>;
  maxWaitConnectionsByType: Record<WaitType | 'None', number>;
  stateConnectionObservations: Record<StateType, number>;
  maxConnectionsByState: Record<StateType, number>;
  lockObservationsByMode: Record<LockModeType, number>;
  maxLocksByMode: Record<LockModeType, number>;
  maxLockCount: number;
  maxWaitingLockCount: number;
  note: 'Wait and lock values are sampled occupancy counts, not duration measurements.';
}

export interface NeonSampler {
  start(): void;
  stop(): Promise<NeonSamplerSummary>;
}

export interface NeonLoadContext {
  database: Database;
  sampler: NeonSampler;
  redactedTarget: string;
}

export interface NeonLoadResult<T> {
  value: T;
  sampler: NeonSamplerSummary;
  redactedTarget: string;
}

export interface NeonLoadDependencies {
  poolFactory?: (config: PoolConfig) => Pool;
  now?: () => number;
}

interface ParsedTarget {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  endpointId: string;
  redactedTarget: string;
}

function fail(code: NeonLoadErrorCode): never {
  throw new NeonLoadError(code);
}

function endpointIdFromHost(host: string): string | null {
  const normalized = host.toLowerCase();
  const labels = normalized.split('.');
  if (
    labels.length < 5 ||
    labels.at(-1) !== 'tech' ||
    labels.at(-2) !== 'neon' ||
    labels.at(-3) !== 'aws' ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    return null;
  const first = labels[0];
  if (!/^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:-pooler)?$/.test(first)) return null;
  const id = first.endsWith('-pooler') ? first.slice(0, -7) : first;
  return id.length > 3 ? id : null;
}

function endpointIdFromValue(value: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 2048 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    return null;
  const normalized = value.toLowerCase();
  if (/^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:-pooler)?$/.test(normalized))
    return normalized.endsWith('-pooler') ? normalized.slice(0, -7) : normalized;
  let candidate = normalized;
  if (normalized.startsWith('postgres://') || normalized.startsWith('postgresql://')) {
    try {
      const url = new URL(value);
      if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.hash) return null;
      const seen = new Set<string>();
      for (const [key, queryValue] of url.searchParams) {
        const normalizedKey = key.toLowerCase();
        if (
          seen.has(normalizedKey) ||
          normalizedKey !== 'sslmode' ||
          queryValue.toLowerCase() !== 'verify-full'
        )
          return null;
        seen.add(normalizedKey);
      }
      candidate = url.hostname;
    } catch {
      return null;
    }
  }
  return endpointIdFromHost(candidate);
}

function decodePart(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function parseTarget(databaseUrl: string): ParsedTarget {
  if (
    typeof databaseUrl !== 'string' ||
    databaseUrl.length > 4096 ||
    /[\u0000-\u001f\u007f]/.test(databaseUrl)
  )
    return fail('INVALID_CONFIGURATION');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return fail('INVALID_CONFIGURATION');
  }
  if (
    (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
    url.hash ||
    url.pathname.length < 2 ||
    url.pathname.length > 64
  )
    return fail('INVALID_CONFIGURATION');
  const queryKeys = new Set<string>();
  for (const [key, value] of url.searchParams) {
    const normalizedKey = key.toLowerCase();
    if (
      queryKeys.has(normalizedKey) ||
      normalizedKey !== 'sslmode' ||
      value.toLowerCase() !== 'verify-full'
    )
      return fail('INVALID_CONFIGURATION');
    queryKeys.add(normalizedKey);
  }
  const user = decodePart(url.username);
  const password = decodePart(url.password);
  const database = decodePart(url.pathname.slice(1));
  const host = url.hostname.toLowerCase();
  const endpointId = endpointIdFromHost(host);
  const port = url.port ? Number(url.port) : 5432;
  if (
    !user ||
    user.length > 63 ||
    !password ||
    password.length > 1024 ||
    !database ||
    database.length > 63 ||
    !endpointId ||
    !Number.isInteger(port) ||
    port !== 5432
  )
    return fail('INVALID_CONFIGURATION');
  return {
    host,
    port,
    user,
    password,
    database,
    endpointId,
    redactedTarget: 'postgresql://<redacted-disposable-neon-endpoint>',
  };
}

function validateInput(input: NeonLoadInput): {
  target: ParsedTarget;
  poolSize: number;
  intervalMs: number;
} {
  if (
    !input ||
    !Array.isArray(input.forbiddenEndpoints) ||
    input.forbiddenEndpoints.length === 0 ||
    input.forbiddenEndpoints.length > 100
  )
    return fail('INVALID_CONFIGURATION');
  const target = parseTarget(input.databaseUrl);
  const declaredId = endpointIdFromValue(input.disposableEndpoint);
  if (!declaredId) return fail('INVALID_DISPOSABLE_ENDPOINT');
  if (declaredId !== target.endpointId) return fail('ENDPOINT_MISMATCH');
  const forbiddenIds = input.forbiddenEndpoints.map(endpointIdFromValue);
  if (forbiddenIds.some((id) => id === null)) return fail('INVALID_FORBIDDEN_ENDPOINT');
  if (forbiddenIds.includes(target.endpointId)) return fail('FORBIDDEN_ENDPOINT');
  const poolSize = input.poolSize ?? DEFAULT_POOL_SIZE;
  const intervalMs = input.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
  if (
    !Number.isInteger(poolSize) ||
    poolSize < 1 ||
    poolSize > 10 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 50 ||
    intervalMs > 60_000
  )
    return fail('INVALID_CONFIGURATION');
  return { target, poolSize, intervalMs };
}

function connectionConfig(target: ParsedTarget, max: number, applicationName: string): PoolConfig {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    application_name: applicationName,
    ssl: { rejectUnauthorized: true },
    max,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 8_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 10_000,
    allowExitOnIdle: true,
  };
}

function createSampler(
  pool: Pool,
  applicationName: string,
  now: () => number,
  intervalMs: number,
): NeonSampler {
  const observations: Record<WaitType | 'None', number> = {
    Activity: 0,
    BufferPin: 0,
    Client: 0,
    IO: 0,
    IPC: 0,
    LWLock: 0,
    Lock: 0,
    Timeout: 0,
    Other: 0,
    None: 0,
  };
  const maxima: Record<WaitType | 'None', number> = {
    Activity: 0,
    BufferPin: 0,
    Client: 0,
    IO: 0,
    IPC: 0,
    LWLock: 0,
    Lock: 0,
    Timeout: 0,
    Other: 0,
    None: 0,
  };
  const stateObservations: Record<StateType, number> = {
    Active: 0,
    Idle: 0,
    IdleInTransaction: 0,
    IdleInTransactionAborted: 0,
    FastpathFunctionCall: 0,
    Disabled: 0,
    Other: 0,
    None: 0,
  };
  const stateMaxima: Record<StateType, number> = { ...stateObservations };
  const lockObservations: Record<LockModeType, number> = {
    AccessShareLock: 0,
    RowShareLock: 0,
    RowExclusiveLock: 0,
    ShareUpdateExclusiveLock: 0,
    ShareLock: 0,
    ShareRowExclusiveLock: 0,
    ExclusiveLock: 0,
    AccessExclusiveLock: 0,
    SIReadLock: 0,
    Other: 0,
  };
  const lockMaxima: Record<LockModeType, number> = { ...lockObservations };
  let sampleCount = 0;
  let sampleErrorCount = 0;
  let rttCount = 0;
  let rttTotal = 0;
  let rttMin = Number.POSITIVE_INFINITY;
  let rttMax = 0;
  let maxLockCount = 0;
  let maxWaitingLockCount = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<NeonSamplerSummary> | undefined;
  let started = false;
  let stopped = false;

  pool.on('error', () => {
    sampleErrorCount++;
  });

  const tick = async () => {
    if (stopped || inFlight) return;
    const work = (async () => {
      const rttStart = now();
      await pool.query('SELECT 1');
      const rtt = Math.max(0, now() - rttStart);
      rttCount++;
      rttTotal += rtt;
      rttMin = Math.min(rttMin, rtt);
      rttMax = Math.max(rttMax, rtt);
      const waits = await pool.query<{
        wait_event_type: string | null;
        state: string | null;
        connection_count: number | string;
      }>(
        `SELECT wait_event_type, state, count(*)::int AS connection_count
         FROM pg_stat_activity
         WHERE datname = current_database() AND application_name = $1 AND pid <> pg_backend_pid()
         GROUP BY wait_event_type, state`,
        [applicationName],
      );
      const locks = await pool.query<{
        mode: string;
        granted: boolean;
        lock_count: number | string;
      }>(
        `SELECT l.mode, l.granted, count(*)::int AS lock_count
         FROM pg_locks AS l
         JOIN pg_stat_activity AS a ON a.pid = l.pid
         WHERE a.datname = current_database() AND a.application_name = $1 AND a.pid <> pg_backend_pid()
         GROUP BY l.mode, l.granted`,
        [applicationName],
      );
      const current: Record<WaitType | 'None', number> = {
        Activity: 0,
        BufferPin: 0,
        Client: 0,
        IO: 0,
        IPC: 0,
        LWLock: 0,
        Lock: 0,
        Timeout: 0,
        Other: 0,
        None: 0,
      };
      const currentStates: Record<StateType, number> = {
        Active: 0,
        Idle: 0,
        IdleInTransaction: 0,
        IdleInTransactionAborted: 0,
        FastpathFunctionCall: 0,
        Disabled: 0,
        Other: 0,
        None: 0,
      };
      const currentLocks: Record<LockModeType, number> = {
        AccessShareLock: 0,
        RowShareLock: 0,
        RowExclusiveLock: 0,
        ShareUpdateExclusiveLock: 0,
        ShareLock: 0,
        ShareRowExclusiveLock: 0,
        ExclusiveLock: 0,
        AccessExclusiveLock: 0,
        SIReadLock: 0,
        Other: 0,
      };
      for (const row of waits.rows) {
        const name =
          row.wait_event_type === null
            ? 'None'
            : (WAIT_TYPES as readonly string[]).includes(row.wait_event_type)
              ? (row.wait_event_type as WaitType)
              : 'Other';
        const count = Number(row.connection_count) || 0;
        current[name] += count;
        const stateMap: Record<string, StateType> = {
          active: 'Active',
          idle: 'Idle',
          'idle in transaction': 'IdleInTransaction',
          'idle in transaction (aborted)': 'IdleInTransactionAborted',
          'fastpath function call': 'FastpathFunctionCall',
          disabled: 'Disabled',
        };
        const stateName = row.state === null ? 'None' : (stateMap[row.state] ?? 'Other');
        currentStates[stateName] += count;
      }
      let locksTotal = 0;
      let locksWaiting = 0;
      for (const row of locks.rows) {
        const count = Number(row.lock_count) || 0;
        locksTotal += count;
        if (!row.granted) locksWaiting += count;
        const mode = (LOCK_MODES as readonly string[]).includes(row.mode)
          ? (row.mode as LockModeType)
          : 'Other';
        currentLocks[mode] += count;
      }
      for (const name of Object.keys(current) as (WaitType | 'None')[]) {
        observations[name] += current[name];
        maxima[name] = Math.max(maxima[name], current[name]);
      }
      for (const name of STATES) {
        stateObservations[name] += currentStates[name];
        stateMaxima[name] = Math.max(stateMaxima[name], currentStates[name]);
      }
      for (const name of LOCK_MODES) {
        lockObservations[name] += currentLocks[name];
        lockMaxima[name] = Math.max(lockMaxima[name], currentLocks[name]);
      }
      maxLockCount = Math.max(maxLockCount, locksTotal);
      maxWaitingLockCount = Math.max(maxWaitingLockCount, locksWaiting);
      sampleCount++;
    })();
    inFlight = work;
    try {
      await work;
    } catch {
      sampleErrorCount++;
    } finally {
      inFlight = undefined;
    }
  };

  const summary = (): NeonSamplerSummary => ({
    sampleCount,
    sampleErrorCount,
    rttMs: {
      count: rttCount,
      minMs: rttCount ? rttMin : null,
      maxMs: rttCount ? rttMax : null,
      meanMs: rttCount ? rttTotal / rttCount : null,
    },
    waitConnectionObservations: { ...observations },
    maxWaitConnectionsByType: { ...maxima },
    stateConnectionObservations: { ...stateObservations },
    maxConnectionsByState: { ...stateMaxima },
    lockObservationsByMode: { ...lockObservations },
    maxLocksByMode: { ...lockMaxima },
    maxLockCount,
    maxWaitingLockCount,
    note: 'Wait and lock values are sampled occupancy counts, not duration measurements.',
  });

  return {
    start() {
      if (started || stopped) return;
      started = true;
      void tick();
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop() {
      if (!stopPromise) {
        stopped = true;
        if (timer) clearInterval(timer);
        stopPromise = (async () => {
          if (inFlight) await inFlight.catch(() => {});
          return summary();
        })();
      }
      return stopPromise;
    },
  };
}

const userRelationsSql = `WITH extension_members AS (
    SELECT classid, objid FROM pg_catalog.pg_depend
    WHERE refclassid = 'pg_catalog.pg_extension'::pg_catalog.regclass AND deptype = 'e'
  )
  SELECT
    (SELECT count(*)::int FROM pg_catalog.pg_namespace AS n
      WHERE n.nspname NOT IN ('public', 'information_schema')
        AND left(n.nspname, 3) <> 'pg_'
        AND NOT EXISTS (SELECT 1 FROM extension_members AS e
          WHERE e.classid = 'pg_catalog.pg_namespace'::pg_catalog.regclass AND e.objid = n.oid)
    ) AS custom_schema_count,
    (SELECT count(*)::int FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
    ) AS relation_count,
    (SELECT count(*)::int FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND NOT EXISTS (SELECT 1 FROM extension_members AS e
          WHERE e.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass AND e.objid = p.oid)
    ) AS function_count,
    (SELECT count(*)::int FROM pg_catalog.pg_type AS t
      JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
      WHERE n.nspname <> 'information_schema' AND left(n.nspname, 3) <> 'pg_'
        AND t.typrelid = 0
        AND NOT EXISTS (SELECT 1 FROM extension_members AS e
          WHERE e.classid = 'pg_catalog.pg_type'::pg_catalog.regclass AND e.objid = t.oid)
    ) AS type_count`;

/**
 * Opens a strictly identified disposable Neon database and always closes both pools.
 * The caller remains responsible for provisioning a truly disposable, fresh branch.
 */
export async function withDisposableNeon<T>(
  input: NeonLoadInput,
  action: (context: NeonLoadContext) => Promise<T>,
  dependencies: NeonLoadDependencies = {},
): Promise<NeonLoadResult<T>> {
  const { target, poolSize, intervalMs } = validateInput(input);
  if (typeof action !== 'function') return fail('INVALID_CONFIGURATION');
  const poolFactory = dependencies.poolFactory ?? ((config) => new Pool(config));
  const now = dependencies.now ?? (() => performance.now());
  const applicationName = `cc-neon-${randomUUID().replaceAll('-', '')}`;
  let appPool: Pool | undefined;
  let samplerPool: Pool | undefined;
  let database: Database | undefined;
  let sampler: NeonSampler | undefined;
  let value!: T;
  let actionError = false;
  let preflightError = false;
  let emptyDatabase = false;
  let poolCreateError = false;
  let cleanupError = false;
  let samplerSummary: NeonSamplerSummary | undefined;

  try {
    try {
      appPool = poolFactory(connectionConfig(target, poolSize, applicationName));
    } catch {
      poolCreateError = true;
    }
    if (appPool) {
      database = postgresDatabase(appPool);
      let hasUserObjects = true;
      try {
        const result = await database.query<{
          custom_schema_count: number | string;
          relation_count: number | string;
          function_count: number | string;
          type_count: number | string;
        }>(userRelationsSql);
        const row = result.rows[0];
        const counts =
          row &&
          [row.custom_schema_count, row.relation_count, row.function_count, row.type_count].map(
            Number,
          );
        if (!counts || counts.some((count) => !Number.isFinite(count))) throw new Error();
        hasUserObjects = counts.some((count) => count !== 0);
      } catch {
        preflightError = true;
      }
      if (!preflightError && hasUserObjects) emptyDatabase = true;
    }
    if (database && !preflightError && !emptyDatabase && !poolCreateError) {
      try {
        samplerPool = poolFactory(connectionConfig(target, 1, applicationName));
      } catch {
        poolCreateError = true;
      }
    }
    if (database && samplerPool && !poolCreateError) {
      sampler = createSampler(samplerPool, applicationName, now, intervalMs);
      try {
        value = await action({ database, sampler, redactedTarget: target.redactedTarget });
      } catch {
        actionError = true;
      }
    }
  } finally {
    if (sampler) {
      try {
        samplerSummary = await sampler.stop();
      } catch {
        cleanupError = true;
      }
    }
    if (samplerPool) {
      try {
        await samplerPool.end();
      } catch {
        cleanupError = true;
      }
    }
    if (database) {
      try {
        await database.close();
      } catch {
        cleanupError = true;
      }
    } else if (appPool) {
      try {
        await appPool.end();
      } catch {
        cleanupError = true;
      }
    }
  }

  if (emptyDatabase) return fail('DATABASE_NOT_EMPTY');
  if (preflightError) return fail('PREFLIGHT_QUERY_FAILED');
  if (actionError) return fail('ACTION_FAILED');
  if (poolCreateError) return fail('POOL_CREATE_FAILED');
  if (cleanupError) return fail('CLEANUP_FAILED');
  if (!samplerSummary) return fail('CLEANUP_FAILED');
  return {
    value,
    sampler: samplerSummary,
    redactedTarget: target.redactedTarget,
  };
}
