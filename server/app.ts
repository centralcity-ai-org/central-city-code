import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import type { PGlite } from '@electric-sql/pglite';
import { openPostgres, type Database, type Transaction as Tx } from './database.js';
import { runMigrations } from './migrations.js';
import { loadLimits, type CityLimits } from './limits.js';
import { stressTestMaxGuests } from './stress-allowlist.js';
import {
  clientAddressKey,
  FAIL_CLOSED_RETRY_MS,
  LOGIN_FAILURES,
  MemoryRateLimiter,
  PostgresRateLimiter,
  type RateLimiter,
} from './rate-limit.js';
import {
  acceptNonce,
  announcedOnline,
  overlayPresence,
  recordHeartbeat,
  resetPresence,
  type PresenceIdentity,
} from './presence.js';
import { checkHostedRequest, loadHostedConfig, type HostedConfig } from './hosted.js';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Operator, Capability, WorkflowDetail } from '../shared/types.js';
import {
  active,
  emptyWorkspace,
  event,
  hasPermission,
  iso,
  LEASE_TTL,
  publicAgent,
  publicJob,
  reachable,
  snapshot,
  stopJob,
  publicWorkflow,
  syncWorkflows,
  type StoredWorkflow,
  type StoredAgent,
  attachInbound,
  type StoredJob,
  type Workspace,
} from './model.js';
import { executeTemplate } from './templates.js';
import { descendants, issueRuntimeCredential, revokeStoredAgent } from './agent-lifecycle.js';
import { acquireDataLock } from './data-lock.js';
import { exportWorkspace } from './export.js';
import {
  assistantAgentSchema,
  assistantJobSchema,
  registerAssistantAccess,
} from './assistant-access.js';
import { registerRemoteMcp, type RemoteMcpTestOptions } from './remote-mcp/index.js';
import { registerAutonomy } from './autonomy/index.js';
import { createMessaging } from './messaging/service.js';
import { registerMessagingRoutes } from './messaging/routes.js';
import { registerMessagingMigration } from './messaging/schema.js';
import { registerPairRemediationMigration } from './messaging/remediation-schema.js';
import { registerAiWorkspacesMigration } from './workspaces/schema.js';
import { registerAiWorkspaces } from './workspaces/service.js';
import { registerCrossConnectionsMigration } from './connections/schema.js';
import { createConnections, loadInbound } from './connections/service.js';
import { registerConnectionRoutes } from './connections/routes.js';
import { registerRoomsMigration } from './rooms/schema.js';
import { registerRoomFormatMigration } from './rooms/format-schema.js';
import { createRooms } from './rooms/service.js';
import { createRoomTasks } from './rooms/tasks-service.js';
import { registerTaskRoutes } from './rooms/tasks-routes.js';
import { roomTasksEnabled } from './rooms/tasks-tools.js';
import {
  createRoomReposFromEnv,
  registerRoomCodeMigration,
  type RoomRepos,
} from './rooms/repos/index.js';
import { registerRoomRepoRoutes } from './rooms/repos/routes.js';
import { registerRoomTasksMigration } from './rooms/tasks-schema.js';
import { registerRoomRoutes } from './rooms/routes.js';
import { registerWakeMigration } from './wake/schema.js';
import { createWake, type WakeOptions } from './wake/service.js';
import { inboxWaiter, registerWakeRoutes } from './wake/routes.js';
import { wakeKeys } from './wake/webhooks.js';
import type { RoomLimits } from './rooms/contract.js';
import { registerResultsMigration } from './results/schema.js';
import { registerResponderMigration } from './responder/schema.js';
import { registerResponderExecutionMigration } from './responder/execution-schema.js';
import { responderKeys } from './responder/keys.js';
import { createResponder, ResponderError } from './responder/service.js';
import { registerResponderRoutes } from './responder/routes.js';
import type { ProviderPostTransport, ProviderTransport } from './responder/providers.js';
import { createResponderDelivery } from './responder/deliver.js';
import { RoomError } from './rooms/service.js';
import { createResults, ResultError } from './results/service.js';
import { registerResultRoutes } from './results/routes.js';
import { pauseKey, syncResultSuspension } from './results/store.js';
import type { ResultOptions } from './results/contract.js';
import { registerJoinLinksMigration } from './links/schema.js';
import { createJoinLinks } from './links/service.js';
import { registerJoinLinkRoutes } from './links/routes.js';
import {
  createPublicStats,
  parseExcludedOperators,
  registerPublicStatsRoutes,
} from './stats/public-stats.js';
import { loadPlatformSigner } from './autonomy/signing.js';
import {
  createCountLog,
  registerCountLogMigration,
  registerCountLogRoutes,
} from './count-log/index.js';
import type { SigningKey } from './manifest/keys.js';
import { requestOrigin } from './oauth/server.js';
import { describeValidation, validationErrorBody } from './validation-errors.js';
import { A2A_PIN, parseA2AIntent, projectNativeJob, createTaskResponse } from '../protocol/a2a.js';
import {
  A2A_AUTH_EXTENSION,
  A2ATransportError,
  a2aMessageKey,
  a2aTaskIds,
  a2aErrorResponse,
} from './a2a.js';

export interface AppOptions {
  dataDir?: string;
  now?: () => number;
  startWorkers?: boolean;
  secureCookies?: boolean;
  hosted?: HostedConfig;
  /** Injection for isolated storage integration tests; never selected from environment. */
  database?: Database;
  /** Test-only injection for the remote MCP/OAuth front door (e.g. a client metadata fetcher). */
  remoteMcp?: RemoteMcpTestOptions;
  /**
   * Request rate limiter. Defaults to a PostgreSQL-backed shared limiter in hosted mode and a
   * bounded in-memory limiter locally. 'memory' and 'postgres' select a built-in explicitly.
   */
  rateLimiter?: RateLimiter | 'memory' | 'postgres';
  /** Capacity overrides applied after CITY_LIMIT_* environment overrides. */
  limits?: Partial<CityLimits>;
  /**
   * Trusted proxy hops for the client address (Fastify trustProxy). Defaults to one hop when
   * the hosted configuration runs on Vercel, otherwise 0 so a direct client cannot spoof
   * X-Forwarded-For.
   */
  trustProxyHops?: number;
  /**
   * Agent Card signing key. Defaults to CITY_SIGNING_KEY, else an ephemeral key locally and no
   * key (cards served unsigned and flagged) in hosted mode. null forces unsigned cards.
   */
  signingKey?: SigningKey | null;
  /** Structured operational log sink (e.g. capacity.pressure lines). Defaults to console.warn. */
  logLine?: (line: string) => void;
  /**
   * Tests only: builds the room repos service (a fake GitHub transport and allowlist) instead of
   * reading the environment (docs/ROOM_REPOS.md).
   */
  roomRepos?: (deps: {
    db: Database;
    clock(): number;
    limit(key: string, max: number, windowMs: number): Promise<void>;
  }) => RoomRepos;
  /** Agent messaging bounds (docs/MESSAGING.md); defaults 1000 unacknowledged and 60 sends/min. */
  messaging?: { inboxDepth?: number; sendsPerMinute?: number };
  /** Room limit overrides (docs/ROOMS.md). */
  rooms?: Partial<RoomLimits>;
  /** Wake-up tuning and the test webhook transport (docs/WAKE.md). */
  wake?: WakeOptions;
  /** Results tuning (ask timeout, candidate cap, principal age; docs/ANSWERS.md). */
  results?: ResultOptions;
  /**
   * Hosted responder (docs/RESPONDER.md). Off unless CITY_RESPONDER=1 (or `enabled`). `env`
   * replaces process.env for the root key; `transport` replaces the provider HTTP calls in tests.
   */
  responder?: {
    enabled?: boolean;
    env?: Record<string, string | undefined>;
    transport?: ProviderTransport;
    /** Replaces the reply calls (POST /v1/messages, /v1/chat/completions) in tests. */
    postTransport?: ProviderPostTransport;
    /** Responder drain budget per kick (default 20 s; review B5). */
    drainBudgetMs?: number;
    /**
     * false: attach no reply delivery to the wake outbox, for tests that drive
     * createResponderDelivery themselves (otherwise the in-process drain would race them).
     */
    delivery?: boolean;
  };
}
export interface CityServices {
  tick(): Promise<void>;
  db: Database;
}
declare module 'fastify' {
  interface FastifyInstance {
    city: CityServices;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}
type OperatorRow = { id: string; name: string; password_hash: string; salt: string };
type RuntimeIdentity = PresenceIdentity;
class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
function fail(code: number, message: string): never {
  throw new ApiError(code, message);
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function constantEqual(left: string, right: string): boolean {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function passwordHash(password: string, salt: string): Promise<string> {
  return new Promise((resolveHash, reject) =>
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) =>
      err ? reject(err) : resolveHash(key.toString('hex')),
    ),
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function validOutput(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let count = 0;
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 8 || ++count > 2000) return false;
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item && typeof item === 'object')
      return Object.entries(item).every(
        ([key, val]) =>
          !['__proto__', 'prototype', 'constructor'].includes(key) && visit(val, depth + 1),
      );
    return true;
  };
  return Buffer.byteLength(JSON.stringify(value)) <= 32768 && visit(value, 0);
}
const authSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-zA-Z0-9 _.-]+$/),
    password: z.string().min(12).max(256),
  })
  .strict();
const agentSchema = assistantAgentSchema;
const pairSchema = z
  .object({ fromAgentId: z.string().uuid(), toAgentId: z.string().uuid() })
  .strict();
const jobSchema = assistantJobSchema;
const idFrom = (request: FastifyRequest) =>
  z.object({ id: z.string().uuid() }).parse(request.params).id;
const workflowSchema = z
  .object({
    requesterId: z.string().uuid(),
    researcherId: z.string().uuid(),
    reviewerId: z.string().uuid(),
    source: z.string().trim().min(1).max(4000),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .refine((key) => !key.startsWith('workflow:')),
  })
  .strict();

/** Hosted mode refuses to start without a shared CITY_RATE_LIMIT_KEY of at least 32 characters. */
export function assertHostedSecret(env: NodeJS.ProcessEnv): void {
  const key = env.CITY_RATE_LIMIT_KEY;
  if (!key || key.length < 32)
    throw new Error(
      'CITY_RATE_LIMIT_KEY must be set to a secret of at least 32 characters in hosted mode (CITY_HOSTED=1 or VERCEL=1); refusing to start.',
    );
}

/** Idle timeout of a browser sign-in: each authenticated request slides it forward. */
export const SESSION_TTL_MS = 24 * 60 * 60_000;
/** Absolute lifetime of a browser sign-in, however active it stays. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
/** Minimum time between two renewals of one session (at most one UPDATE per interval). */
export const SESSION_RENEW_INTERVAL_MS = 60 * 60_000;
/** Browsers (and tools) that can stay signed in to one account at once. */
export const SESSIONS_PER_ACCOUNT = 20;

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const clock = options.now ?? Date.now;
  if (!options.hosted && (process.env.CITY_HOSTED === '1' || process.env.VERCEL === '1'))
    options = { ...options, hosted: loadHostedConfig() };
  if (options.hosted) {
    // Hosted instances derive rate-limit, known-device and unclaimed-partition identifiers from
    // this secret; a per-instance random fallback would split them across instances.
    assertHostedSecret(process.env);
    const db = options.database ?? (await openPostgres(options.hosted.databaseUrl));
    try {
      return await createDatabaseApp(options, clock, db, () => undefined);
    } catch {
      await db.close();
      throw new Error('Hosted database initialization failed.');
    }
  }
  const requestedDataDir =
    options.dataDir === ':memory:' ? 'memory://' : (options.dataDir ?? resolve('.local/data'));
  const dataLock =
    requestedDataDir === 'memory://' ? undefined : await acquireDataLock(requestedDataDir);
  const dataDir = dataLock?.dataDir ?? requestedDataDir;
  let openedDb: PGlite | undefined;
  try {
    if (dataDir !== 'memory://') await mkdir(dirname(dataDir), { recursive: true });
    const { PGlite } = await import('@electric-sql/pglite');
    const db = (openedDb = await PGlite.create(dataDir));
    return await createDatabaseApp(options, clock, db, () => dataLock?.release());
  } catch (error) {
    if (openedDb) await openedDb.close();
    await dataLock?.release();
    throw error;
  }
}

async function createDatabaseApp(
  options: AppOptions,
  clock: () => number,
  db: Database,
  releaseDataLock: () => Promise<void> | undefined,
): Promise<FastifyInstance> {
  // Versioned, forward-only schema under the shared advisory lock (server/migrations.ts).
  // Feature modules register their migrations before the ledger runs (10: agent_messages).
  registerMessagingMigration();
  // 25: one-time remediation of #61-era pair ids (data migration; needs 10, 15 and 19).
  registerPairRemediationMigration();
  // 11: AI-owned workspaces and keys; 12: cross-workspace connection requests.
  registerAiWorkspacesMigration();
  registerCrossConnectionsMigration();
  // 13: rooms; 14: universal join links.
  registerRoomsMigration();
  registerJoinLinksMigration();
  // 15: mentions and wake-up.
  registerWakeMigration();
  // 16: published results.
  registerResultsMigration();
  // 22: room_messages.format (plain|markdown).
  registerRoomFormatMigration();
  // Room tasks: the schema always exists; the MCP tools are behind CITY_ROOM_TASKS=1.
  registerRoomTasksMigration();
  // 23: room repos, proposals, reviews and evidence; the tools are behind
  // CITY_ROOM_REPOS=1 (docs/ROOM_REPOS.md).
  registerRoomCodeMigration();
  // 20: hosted responder settings and write-only provider keys. The schema always exists
  // (it also registers on import); the feature itself is behind CITY_RESPONDER=1.
  registerResponderMigration();
  // 26: responder execution (reply leases, usage, wake target kinds, unread_count, room columns).
  registerResponderExecutionMigration();
  // 29: the verifiable agent count's append-only log (docs: AGENT_COUNT_TRANSPARENCY spec).
  registerCountLogMigration();
  await runMigrations(db);
  const caps = loadLimits(process.env, options.limits);
  // Number of trusted proxy hops nearest the socket; 0 disables X-Forwarded-For entirely.
  const trustedHops = options.trustProxyHops ?? (options.hosted?.trustProxy ? 1 : 0);
  const trustProxy = trustedHops > 0 ? (_address: string, hop: number) => hop < trustedHops : false;
  const app = Fastify({
    logger: false,
    bodyLimit: 65536,
    requestTimeout: 15000,
    connectionTimeout: 15000,
    // Only Vercel's edge sets a trustworthy X-Forwarded-For; trust exactly that one hop.
    trustProxy,
  });
  await app.register(cookie);
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, body ? JSON.parse(body as string) : {});
    } catch {
      done(new ApiError(400, 'Invalid JSON'));
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    if (typeof retryAfterMs === 'number')
      reply.header('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    if (_request.url.startsWith('/api/runtime/a2a/')) {
      const response = a2aErrorResponse(
        // A2A keeps its JSON-RPC error shape; only the message names the fields.
        error instanceof z.ZodError ? new ApiError(400, describeValidation(error).message) : error,
        _request.body,
      );
      return reply
        .header('A2A-Version', A2A_PIN.wireVersion)
        .code(response.status)
        .send(response.body);
    }
    // Field-level detail (paths and constraints only, never received values).
    if (error instanceof z.ZodError) return reply.code(400).send(validationErrorBody(error));
    const possible = error as { statusCode?: number; message?: string };
    // Stable machine-readable codes (messaging) accompany the message.
    const errorCode = (error as { errorCode?: unknown }).errorCode;
    const code =
      error instanceof ApiError
        ? error.statusCode
        : typeof possible.statusCode === 'number' &&
            ((possible.statusCode >= 400 && possible.statusCode < 500) ||
              // Only the ask timeout keeps its 503 (retryable, with Retry-After).
              (error instanceof ResultError &&
                error.statusCode === 503 &&
                errorCode === 'ask_timeout') ||
              // The responder provider could not be reached (502), or the feature has no root key (503).
              (error instanceof ResponderError &&
                (error.statusCode === 502 || error.statusCode === 503)))
          ? possible.statusCode
          : 500;
    if (code === 500) app.log.error('Request failed.');
    const issues = (error as { issues?: unknown }).issues;
    return reply.code(code).send({
      error:
        code === 500
          ? 'The operation could not be completed.'
          : (possible.message ?? 'Request rejected.'),
      ...(code !== 500 && typeof errorCode === 'string' ? { code: errorCode } : {}),
      // Machine-actionable manifest issues (autonomy routes) accompany the message.
      ...(code !== 500 && Array.isArray(issues) ? { issues } : {}),
    });
  });
  const limiter: RateLimiter =
    typeof options.rateLimiter === 'object'
      ? options.rateLimiter
      : (options.rateLimiter ?? (options.hosted ? 'postgres' : 'memory')) === 'postgres'
        ? new PostgresRateLimiter(db, clock)
        : new MemoryRateLimiter(clock);
  async function limit(key: string, max: number, window: number): Promise<void> {
    const result = await limiter.hit(key, max, window);
    if (!result.allowed)
      throw new ApiError(429, 'Too many requests. Try again later.', result.retryAfterMs);
  }
  // Session renewal happens during the operator lookup, which only receives the request.
  const replies = new WeakMap<FastifyRequest, FastifyReply>();
  const renewedSessions = new WeakMap<FastifyRequest, number>();
  app.addHook('onRequest', async (request, reply) => {
    replies.set(request, reply);
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'same-origin');
    if (!request.url.startsWith('/api/')) return;
    const host = request.headers.host ?? '';
    const origin = request.headers.origin;
    if (options.hosted) {
      if (!checkHostedRequest(options.hosted, host, origin))
        fail(403, 'Host or origin is not allowed.');
    } else {
      let hostname: string;
      try {
        hostname = new URL(`http://${host}`).hostname;
      } catch {
        return fail(403, 'Invalid host.');
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname))
        fail(403, 'This development server accepts localhost only.');

      if (origin) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          return fail(403, 'Invalid origin.');
        }
        if (parsed.host !== host || parsed.protocol !== `${request.protocol}:`)
          fail(403, 'Cross-origin requests are not allowed.');
      }
    }
    await limit(`ip:${clientAddressKey(request.ip)}`, 600, 60_000);
    const runtime = request.url.startsWith('/api/runtime/');
    // Anonymous creation carries no cookie authority, so it needs no CSRF header.
    const cookieless = runtime || request.url.startsWith('/api/public/');
    if (!runtime && !['GET', 'HEAD'].includes(request.method)) {
      if (!cookieless && request.headers['x-city-request'] !== '1')
        fail(403, 'Missing request protection header.');
      if (!request.headers['content-type']?.startsWith('application/json'))
        fail(415, 'Use application/json.');
    }
  });
  const subscribers = new Map<string, Set<FastifyReply>>();
  const subscriptionSessions = new Map<FastifyReply, string>();
  function notify(operatorId: string): void {
    const message = `event: invalidate\ndata: ${JSON.stringify({ revision: randomUUID() })}\n\n`;
    for (const reply of subscribers.get(operatorId) ?? []) {
      if (reply.raw.writableEnded || reply.raw.destroyed) continue;
      if (!reply.raw.write(message)) reply.raw.end();
    }
  }
  async function readWorkspace(tx: Tx, operatorId: string, lock = false): Promise<Workspace> {
    const row = (
      await tx.query<{ data: Workspace }>(
        `SELECT data FROM workspaces WHERE operator_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [operatorId],
      )
    ).rows[0];
    if (!row) fail(401, 'Sign in to continue.');
    // Runtime presence is authoritative in agent_presence (server/presence.ts).
    await overlayPresence(tx, operatorId, row.data);
    // Accepted cross-workspace connections, never persisted in the document (server/model.ts).
    attachInbound(row.data, await loadInbound(tx, operatorId));
    return row.data;
  }
  async function mutate<T>(
    operatorId: string,
    action: (workspace: Workspace, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T> {
    let changed = false;
    const result = await db.transaction(async (tx) => {
      const workspace = await readWorkspace(tx, operatorId, true);
      const before = JSON.stringify(workspace);
      const paused = pauseKey(workspace);
      const time = clock();
      syncWorkflows(workspace, time);
      const response = await action(workspace, tx, time);
      syncWorkflows(workspace, time);
      // Pausing or resuming the workspace or an agent suspends or restores its published
      // results in the same transaction, whichever path changed the pause state.
      if (pauseKey(workspace) !== paused)
        await syncResultSuspension(tx, operatorId, workspace, time);
      const after = JSON.stringify(workspace);
      changed = before !== after;
      if (changed)
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
          operatorId,
          after,
        ]);
      return response;
    });
    if (changed) notify(operatorId);
    return result;
  }
  /** Locks several workspaces in sorted order (deadlock-free) and writes those that changed. */
  async function mutateMany<T>(
    operatorIds: string[],
    action: (workspaces: Map<string, Workspace>, tx: Tx, time: number) => T | Promise<T>,
  ): Promise<T> {
    const ids = [...new Set(operatorIds)].sort();
    const changed: string[] = [];
    const result = await db.transaction(async (tx) => {
      const time = clock();
      const workspaces = new Map<string, Workspace>();
      const before = new Map<string, string>();
      const paused = new Map<string, string>();
      for (const id of ids) {
        const workspace = await readWorkspace(tx, id, true);
        before.set(id, JSON.stringify(workspace));
        paused.set(id, pauseKey(workspace));
        syncWorkflows(workspace, time);
        workspaces.set(id, workspace);
      }
      const response = await action(workspaces, tx, time);
      for (const id of ids) {
        const workspace = workspaces.get(id)!;
        syncWorkflows(workspace, time);
        if (pauseKey(workspace) !== paused.get(id))
          await syncResultSuspension(tx, id, workspace, time);
        const after = JSON.stringify(workspace);
        if (after === before.get(id)) continue;
        await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [id, after]);
        changed.push(id);
      }
      return response;
    });
    for (const id of changed) notify(id);
    return result;
  }
  async function optionalOperator(request: FastifyRequest): Promise<Operator | null> {
    const token = request.cookies.cc_session;
    if (!token || token.length > 128) return null;
    const hash = sha(token),
      time = clock();
    const row = (
      await db.query<Operator & { expires_at: string | number; created_at: string | number }>(
        'SELECT o.id,o.name,s.expires_at,s.created_at FROM operators o JOIN sessions s ON s.operator_id=o.id WHERE s.token_hash=$1 AND s.expires_at>$2',
        [hash, time],
      )
    ).rows[0];
    if (!row) return null;
    // Sliding renewal: activity extends the 24 h idle timeout, capped at 30 days after sign-in.
    // Throttled to one conditional UPDATE per hour per session, outside any transaction.
    const expiresAt = Number(row.expires_at),
      renewed = Math.min(time + SESSION_TTL_MS, Number(row.created_at) + SESSION_MAX_AGE_MS);
    if (expiresAt - time < SESSION_TTL_MS - SESSION_RENEW_INTERVAL_MS && renewed > expiresAt) {
      const updated = await db.query(
        'UPDATE sessions SET expires_at=$3 WHERE token_hash=$1 AND expires_at>$2 AND expires_at<$3 RETURNING token_hash',
        [hash, time, renewed],
      );
      if (updated.rows.length) {
        const maxAge = Math.floor((renewed - time) / 1000);
        renewedSessions.set(request, maxAge);
        const reply = replies.get(request);
        if (reply) setSessionCookie(reply, token, maxAge);
      }
    }
    return { id: row.id, name: row.name };
  }
  function sessionCookieOptions(maxAge: number) {
    return {
      httpOnly: true,
      secure: options.hosted ? true : (options.secureCookies ?? false),
      sameSite: 'strict' as const,
      path: '/',
      maxAge,
    };
  }
  function setSessionCookie(reply: FastifyReply, token: string, maxAge: number): void {
    reply.setCookie('cc_session', token, sessionCookieOptions(maxAge));
  }
  /** The signed-in person (session cookie), whatever workspace the request selects. */
  async function person(request: FastifyRequest): Promise<Operator> {
    return (await optionalOperator(request)) ?? fail(401, 'Sign in to continue.');
  }
  /**
   * The workspace a console request acts in: the signed-in person's own, or an AI-owned workspace
   * they co-own, selected with the X-City-Workspace header (the event stream, which cannot send
   * headers, uses ?workspace=). Co-ownership is an operator_links row (docs/AI_WORKSPACES.md);
   * everything downstream stays scoped by the one returned operator id.
   */
  async function owner(request: FastifyRequest): Promise<Operator> {
    const human = await person(request);
    const header = request.headers['x-city-workspace'];
    const query = request.url.startsWith('/api/events?')
      ? new URLSearchParams(request.url.slice(request.url.indexOf('?') + 1)).get('workspace')
      : null;
    const selected = typeof header === 'string' ? header : query;
    if (!selected || selected === human.id) return human;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selected))
      fail(404, 'Workspace not found.');
    const row = (
      await db.query<Operator>(
        "SELECT o.id,o.name FROM operator_links l JOIN operators o ON o.id=l.ai_operator_id AND o.kind='ai' WHERE l.human_operator_id=$1 AND l.ai_operator_id=$2",
        [human.id, selected],
      )
    ).rows[0];
    return row ?? fail(404, 'Workspace not found.');
  }
  async function session(tx: Tx, reply: FastifyReply, operatorId: string): Promise<void> {
    // Sign-ins idle out after 24 h (activity renews them, 30-day cap), up to SESSIONS_PER_ACCOUNT
    // browsers per account (the oldest is signed out; token_hash breaks created_at ties).
    const token = randomBytes(32).toString('base64url'),
      time = clock();
    await tx.query('DELETE FROM sessions WHERE expires_at<=$1', [time]);
    await tx.query(
      'DELETE FROM sessions WHERE operator_id=$1 AND token_hash IN (SELECT token_hash FROM sessions WHERE operator_id=$1 ORDER BY created_at DESC, token_hash DESC OFFSET $2)',
      [operatorId, SESSIONS_PER_ACCOUNT - 1],
    );
    await tx.query(
      'INSERT INTO sessions (token_hash,operator_id,expires_at,created_at) VALUES ($1,$2,$3,$4)',
      [sha(token), operatorId, time + SESSION_TTL_MS, time],
    );
    setSessionCookie(reply, token, SESSION_TTL_MS / 1000);
  }
  function ensureAgent(workspace: Workspace, id: string): StoredAgent {
    return workspace.agents.find((agent) => agent.id === id) ?? fail(404, 'Agent not found.');
  }
  function ensureJob(workspace: Workspace, id: string): StoredJob {
    return workspace.jobs.find((job) => job.id === id) ?? fail(404, 'Job not found.');
  }
  async function currentRuntimeAgent(
    workspace: Workspace,
    tx: Tx,
    identity: RuntimeIdentity,
  ): Promise<StoredAgent> {
    const agent = ensureAgent(workspace, identity.agentId);
    const current = await tx.query(
      'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
      [identity.agentId, identity.operatorId, identity.credentialHash],
    );
    if (agent.revokedAt || agent.mode !== 'external' || !current.rows.length)
      fail(401, 'Invalid runtime credential.');
    return agent;
  }
  function mutateRuntime<T>(
    identity: RuntimeIdentity,
    action: (workspace: Workspace, agent: StoredAgent, time: number) => T | Promise<T>,
  ): Promise<T> {
    return mutate(identity.operatorId, async (workspace, tx, time) => {
      // Authentication and mutation are separate transactions. Recheck the exact credential
      // under the workspace lock so a rotation between them cannot revive old authority.
      const agent = await currentRuntimeAgent(workspace, tx, identity);
      return action(workspace, agent, time);
    });
  }
  async function runtime(
    request: FastifyRequest,
    options: { query?: boolean } = {},
  ): Promise<RuntimeIdentity> {
    const authorization = request.headers.authorization ?? '';
    if (!authorization.startsWith('Bearer ') || authorization.length > 160)
      fail(401, 'Invalid runtime credential.');
    const token = authorization.slice(7);
    const credential = (
      await db.query<{ operator_id: string; agent_id: string; token_hash: string }>(
        'SELECT operator_id,agent_id,token_hash FROM credentials WHERE token_hash=$1',
        [sha(token)],
      )
    ).rows[0];
    if (!credential || !constantEqual(credential.token_hash, sha(token)))
      fail(401, 'Invalid runtime credential.');
    const identity: RuntimeIdentity = {
      operatorId: credential.operator_id,
      agentId: credential.agent_id,
      credentialHash: credential.token_hash,
    };
    await limit(`runtime:${credential.agent_id}`, 120, 60_000);
    const stamp = request.headers['x-cc-timestamp'],
      nonce = request.headers['x-cc-nonce'],
      signature = request.headers['x-cc-signature'];
    if (
      typeof stamp !== 'string' ||
      !/^\d{13}$/.test(stamp) ||
      Math.abs(clock() - Number(stamp)) > 60_000 ||
      typeof nonce !== 'string' ||
      !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce) ||
      typeof signature !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(signature)
    )
      fail(401, 'Invalid or expired runtime signature.');
    // Routes that take query parameters sign the full request target (path and query).
    const pathname = options.query ? request.url : request.url.split('?')[0];
    if (!options.query && request.url.includes('?'))
      fail(400, 'Runtime query parameters are not supported.');
    const payload = `${request.method}\n${pathname}\n${stamp}\n${nonce}\n${sha(request.rawBody ?? '')}`;
    const expected = createHmac('sha256', token).update(payload).digest('hex');
    if (!constantEqual(signature.toLowerCase(), expected))
      fail(401, 'Invalid or expired runtime signature.');
    // Locks only this agent's presence row; never the owner's workspace row.
    const accepted = await db.transaction((tx) =>
      acceptNonce(tx, identity, nonce, clock(), caps.replayNoncesPerAgent),
    );
    if (accepted === 'unauthorized') fail(401, 'Invalid runtime credential.');
    if (accepted === 'capacity') fail(429, 'Runtime replay capacity reached.');
    if (accepted === 'replayed') fail(409, 'Runtime request was already used.');
    return identity;
  }

  app.get('/api/session', async (request) => ({
    operator: await optionalOperator(request),
    setupRequired:
      Number(
        (await db.query<{ count: string }>("SELECT count(*) FROM operators WHERE kind='owner'"))
          .rows[0]?.count,
      ) === 0,
  }));
  app.post('/api/auth/register', async (request, reply) => {
    await limit(
      `register:${clientAddressKey(request.ip)}`,
      caps.registrationsPerWindow,
      15 * 60_000,
    );
    const { name, password } = authSchema.parse(request.body);
    const salt = randomBytes(16).toString('hex'),
      hash = await passwordHash(password, salt);
    const operator = { id: randomUUID(), name };
    await db.transaction(async (tx) => {
      await tx.query('LOCK TABLE operators IN SHARE ROW EXCLUSIVE MODE');
      const count = Number(
        (await tx.query<{ count: string }>("SELECT count(*) FROM operators WHERE kind='owner'"))
          .rows[0]?.count,
      );
      if (count >= caps.operators) fail(409, 'Account limit reached.');
      if (
        (await tx.query('SELECT id FROM operators WHERE name_key=$1', [name.toLowerCase()])).rows
          .length
      )
        fail(409, 'That account name is unavailable.');
      await tx.query(
        'INSERT INTO operators(id,name,name_key,password_hash,salt,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [operator.id, name, name.toLowerCase(), hash, salt, clock()],
      );
      const workspace = emptyWorkspace();
      event(workspace, clock(), 'operator.created', 'Operator account created.');
      await tx.query('INSERT INTO workspaces(operator_id,data) VALUES($1,$2::jsonb)', [
        operator.id,
        JSON.stringify(workspace),
      ]);
      await session(tx, reply, operator.id);
    });
    return reply.code(201).send({ operator });
  });
  // Known-device cookie: a browser that has signed in to an account before carries an HMAC of
  // the operator id, which exempts it from the account-wide failure ceiling (not from the
  // per-source budget). Stateless and unforgeable without the server secret, so an attacker
  // spreading failures across many sources cannot lock the owner's own browser out.
  const deviceSecret = process.env.CITY_RATE_LIMIT_KEY || randomBytes(32).toString('base64url');
  const deviceToken = (operatorId: string) =>
    createHmac('sha256', deviceSecret).update(`known-device:${operatorId}`).digest('base64url');
  function rememberDevice(reply: FastifyReply, operatorId: string): void {
    reply.setCookie('cc_device', deviceToken(operatorId), {
      httpOnly: true,
      secure: options.hosted ? true : (options.secureCookies ?? false),
      sameSite: 'strict',
      path: '/',
      maxAge: 180 * 24 * 60 * 60,
    });
  }
  /** Password check shared by the owner login and the OAuth consent page; callers rate-limit. */
  async function authenticate(
    values: unknown,
    address: string,
    request: FastifyRequest,
  ): Promise<Operator> {
    const { name, password } = authSchema.parse(values);
    const nameKey = name.toLowerCase();
    // Budgets apply to submitted names whether or not they exist, so lockout never reveals which
    // accounts exist. The per-source attempt is counted atomically before the slow password
    // check, so parallel requests cannot exceed it. The account-wide failure ceiling does not
    // apply to a browser that previously signed in to this account (known-device cookie).
    const accountKey = `login-fail:account:${nameKey}`;
    const attempt = await limiter.hit(
      `login-attempt:${nameKey}:${address}`,
      LOGIN_FAILURES.perAccountAddress,
      LOGIN_FAILURES.windowMs,
    );
    if (!attempt.allowed)
      throw new ApiError(
        429,
        'Too many failed sign-in attempts. Try again later.',
        attempt.retryAfterMs,
      );
    const row = (
      await db.query<OperatorRow>(
        "SELECT id,name,password_hash,salt FROM operators WHERE name_key=$1 AND kind='owner'",
        [nameKey],
      )
    ).rows[0];
    const device = request.cookies.cc_device;
    const knownDevice = Boolean(row && device && constantEqual(device, deviceToken(row.id)));
    const accountFailures = knownDevice
      ? 0
      : await limiter.count(accountKey, LOGIN_FAILURES.windowMs);
    if (accountFailures >= LOGIN_FAILURES.perAccount)
      throw new ApiError(
        429,
        'Too many failed sign-in attempts. Try again later.',
        // A fail-closed outage reads as exhausted: retry shortly. Otherwise, at most the window.
        accountFailures === Number.MAX_SAFE_INTEGER
          ? FAIL_CLOSED_RETRY_MS
          : LOGIN_FAILURES.windowMs,
      );
    const hash = await passwordHash(password, row?.salt ?? 'central-city-invalid-account-salt');
    if (!row || !constantEqual(row.password_hash, hash)) {
      await limiter.hit(accountKey, LOGIN_FAILURES.perAccount, LOGIN_FAILURES.windowMs);
      fail(401, 'Invalid account name or password.');
    }
    return { id: row.id, name: row.name };
  }
  app.post('/api/auth/login', async (request, reply) => {
    await limit(`login:${clientAddressKey(request.ip)}`, 20, 15 * 60_000);
    const operator = await authenticate(request.body, clientAddressKey(request.ip), request);
    await db.transaction((tx) => session(tx, reply, operator.id));
    rememberDevice(reply, operator.id);
    return { operator };
  });
  app.post('/api/auth/logout', async (request, reply) => {
    const token = request.cookies.cc_session;
    if (token) {
      const hash = sha(token);
      await db.query('DELETE FROM sessions WHERE token_hash=$1', [hash]);
      for (const [client, clientHash] of subscriptionSessions)
        if (clientHash === hash) client.raw.end();
    }
    reply.clearCookie('cc_session', {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: options.hosted ? true : (options.secureCookies ?? false),
    });
    return { ok: true };
  });
  app.get('/api/snapshot', async (request) => {
    const operator = await owner(request);
    // Polling advances hosted demonstrations. Controls must apply without first
    // completing work that the operator is trying to cancel, pause or revoke.
    if (options.hosted) await performTick(operator.id);
    return snapshot(await readWorkspace(db, operator.id), operator, clock());
  });
  app.get('/api/events', async (request, reply) => {
    const operator = await owner(request);
    // 204 stops EventSource reconnecting; the UI already polls every 15 seconds.
    if (options.hosted) return reply.code(204).send();
    const clients = subscribers.get(operator.id) ?? new Set<FastifyReply>();
    if (clients.size >= 4) fail(429, 'Live connection limit reached.');
    const total = [...subscribers.values()].reduce((sum, set) => sum + set.size, 0);
    if (total >= 100) fail(429, 'Live connection limit reached.');
    reply.hijack();
    // A hijacked reply skips the cookie onSend hook, so a renewal is written here directly.
    const renewedMaxAge = renewedSessions.get(request);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(renewedMaxAge === undefined
        ? {}
        : {
            'Set-Cookie': app.serializeCookie(
              'cc_session',
              request.cookies.cc_session!,
              sessionCookieOptions(renewedMaxAge),
            ),
          }),
    });
    clients.add(reply);
    subscribers.set(operator.id, clients);
    const sessionHash = sha(request.cookies.cc_session!);
    subscriptionSessions.set(reply, sessionHash);
    reply.raw.write('retry: 3000\nevent: invalidate\ndata: {"connected":true}\n\n');
    const ping = setInterval(() => {
      void db
        .query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>$2', [
          sessionHash,
          clock(),
        ])
        .then((result) => {
          if (
            !result.rows.length ||
            (!reply.raw.writableEnded && !reply.raw.write(': keepalive\n\n'))
          )
            reply.raw.end();
        })
        .catch(() => reply.raw.end());
    }, 15_000);
    const expiry = setTimeout(() => reply.raw.end(), 5 * 60_000);
    ping.unref();
    expiry.unref();
    reply.raw.on('close', () => {
      clearInterval(ping);
      clearTimeout(expiry);
      clients.delete(reply);
      subscriptionSessions.delete(reply);
      if (!clients.size) subscribers.delete(operator.id);
    });
    return reply;
  });

  app.post('/api/agents', async (request, reply) => {
    const operator = await owner(request),
      values = agentSchema.parse(request.body);
    const response = await mutate(operator.id, async (workspace, tx, time) => {
      if (workspace.agents.length >= caps.agentsPerWorkspace)
        fail(409, `Local workspace limit of ${caps.agentsPerWorkspace} agents reached.`);
      const agent: StoredAgent = {
        id: randomUUID(),
        ...values,
        isDemo: values.mode === 'hosted',
        lastSeenAt: null,
        createdAt: iso(time),
        revokedAt: null,
        lastSequence: -1,
        announcedOnline: false,
      };
      workspace.agents.push(agent);
      event(
        workspace,
        time,
        'agent.registered',
        `${agent.name} registered as ${agent.mode === 'hosted' ? 'a deterministic demonstration' : 'an external runtime'}.`,
        agent.id,
      );
      let token: string | undefined;
      if (agent.mode === 'external') {
        token = randomBytes(32).toString('base64url');
        await tx.query(
          'INSERT INTO credentials(token_hash,operator_id,agent_id) VALUES($1,$2,$3)',
          [sha(token), operator.id, agent.id],
        );
      }
      return { agent: publicAgent(agent, workspace.jobs, time), ...(token ? { token } : {}) };
    });
    return reply.code(201).send(response);
  });
  app.post('/api/agents/:id/revoke', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, async (workspace, tx, time) => {
      const agent = ensureAgent(workspace, id);
      // Revocation cascades down the parentAgentId lineage (agents created under this one).
      for (const target of [agent, ...descendants(workspace, agent.id)])
        await revokeStoredAgent(
          workspace,
          tx,
          operator.id,
          target,
          time,
          target === agent
            ? undefined
            : `${target.name} revoked because its parent agent ${agent.name} was revoked.`,
        );
      return { ok: true };
    });
  });
  app.post('/api/agents/:id/rotate-credential', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, async (workspace, tx, time) => {
      const agent = ensureAgent(workspace, id);
      if (agent.mode !== 'external') fail(409, 'Hosted agents do not use runtime credentials.');
      if (agent.revokedAt) fail(409, 'Revoked agents cannot rotate credentials.');
      // Replaced in the same transaction as presence, cancellation and the audit event.
      const token = await issueRuntimeCredential(
        workspace,
        tx,
        operator.id,
        agent,
        time,
        'rotated',
      );
      return { agent: publicAgent(agent, workspace.jobs, time), token };
    });
  });
  app.post('/api/connections', async (request, reply) => {
    const operator = await owner(request),
      values = pairSchema.parse(request.body);
    const response = await mutate(operator.id, (workspace, _tx, time) => {
      if (values.fromAgentId === values.toAgentId) fail(400, 'Choose two different agents.');
      const from = ensureAgent(workspace, values.fromAgentId),
        to = ensureAgent(workspace, values.toAgentId);
      if (from.revokedAt || to.revokedAt) fail(409, 'Revoked agents cannot connect.');
      const existing = workspace.connections.find(
        (connection) => connection.fromAgentId === from.id && connection.toAgentId === to.id,
      );
      if (existing) return { connection: existing };
      if (workspace.connections.length >= caps.connectionsPerWorkspace)
        fail(409, 'Local connection limit reached.');
      const connection = { id: randomUUID(), ...values, createdAt: iso(time) };
      workspace.connections.push(connection);
      event(
        workspace,
        time,
        'connection.authorized',
        `${from.name} may request work from ${to.name}.`,
        to.id,
      );
      return { connection };
    });
    return reply.code(201).send(response);
  });
  app.delete('/api/connections/:id', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const connection =
        workspace.connections.find((item) => item.id === id) ?? fail(404, 'Connection not found.');
      workspace.connections = workspace.connections.filter((item) => item.id !== id);
      for (const job of workspace.jobs)
        if (job.requesterId === connection.fromAgentId && job.providerId === connection.toAgentId)
          stopJob(workspace, job, time, 'Work stopped because its connection was revoked.');
      event(
        workspace,
        time,
        'connection.revoked',
        'Directional connection revoked.',
        connection.toAgentId,
      );
      return { ok: true };
    });
  });
  function admitJob(
    workspace: Workspace,
    values: z.infer<typeof jobSchema>,
    time: number,
    transportHash?: string,
    /** Requester in another workspace (accepted cross-workspace connection, checked by caller). */
    remoteRequester?: StoredAgent,
  ) {
    const requestHash =
      transportHash ??
      sha(
        canonical({
          requesterId: values.requesterId,
          providerId: values.providerId,
          input: values.input,
        }),
      );
    const existing = workspace.jobs.find((job) => job.idempotencyKey === values.idempotencyKey);
    // A remote requester's key is bound to that requester: it never resolves another's job.
    if (existing && remoteRequester && existing.requesterId !== remoteRequester.id)
      fail(409, 'This idempotency key belongs to a different requester.');
    if (existing) {
      if (existing.requestHash !== requestHash)
        fail(409, 'This idempotency key belongs to different job input.');
      return { job: publicJob(existing) };
    }
    if (workspace.paused) fail(409, 'Workspace is paused.');
    if (!hasPermission(workspace, values))
      fail(403, 'A current directional connection is required.');
    const requester = remoteRequester ?? ensureAgent(workspace, values.requesterId),
      provider = ensureAgent(workspace, values.providerId);
    if (remoteRequester && remoteRequester.id !== values.requesterId)
      fail(400, 'Requester mismatch.');
    if (options.hosted) refreshPresence(workspace, time);
    // A remote requester's liveness is checked in its own workspace (revoked or paused refuses).
    if ((!remoteRequester && !reachable(requester, time)) || !reachable(provider, time))
      fail(409, 'Both agents must be reachable.');
    const activeJobs = workspace.jobs.filter(active);
    if (
      activeJobs.length >= caps.activeJobsPerWorkspace ||
      [requester.id, provider.id].some(
        (id) =>
          activeJobs.filter((job) => job.requesterId === id || job.providerId === id).length >=
          caps.activeJobsPerAgent,
      )
    )
      fail(
        409,
        `Active job capacity reached (${caps.activeJobsPerAgent} per agent, ${caps.activeJobsPerWorkspace} per workspace).`,
      );
    if (workspace.jobs.length >= caps.jobsPerWorkspace)
      fail(
        409,
        `Local history limit of ${caps.jobsPerWorkspace} jobs reached. Export/archive support is required before further work.`,
      );
    const job: StoredJob = {
      id: randomUUID(),
      requesterId: requester.id,
      providerId: provider.id,
      capability: provider.capability,
      input: values.input,
      status: 'queued',
      acceptance: 'pending',
      output: null,
      createdAt: iso(time),
      updatedAt: iso(time),
      completedAt: null,
      acceptedAt: null,
      costCents: provider.mode === 'hosted' ? 0 : null,
      error: null,
      isDemo: requester.isDemo || provider.isDemo,
      idempotencyKey: values.idempotencyKey,
      requestHash,
      attempts: 0,
      leaseHash: null,
      leaseExpiresAt: null,
      outputHash: null,
    };
    workspace.jobs.push(job);
    event(
      workspace,
      time,
      'job.submitted',
      `${requester.name} requested ${provider.capability} from ${provider.name}.`,
      provider.id,
      job.id,
    );
    return { job: publicJob(job) };
  }
  app.post('/api/jobs', async (request, reply) => {
    const operator = await owner(request),
      values = jobSchema.parse(request.body);
    const response = await mutate(operator.id, (workspace, _tx, time) =>
      admitJob(workspace, values, time),
    );
    return reply.code(201).send(response);
  });
  const originOf = (request: FastifyRequest) => requestOrigin(request, options.hosted);
  // One platform signer for Agent Cards and count checkpoints (distinct signing contexts).
  const platformSigner = loadPlatformSigner(
    process.env,
    Boolean(options.hosted),
    undefined,
    options.signingKey,
  );
  const autonomy = await registerAutonomy(app, {
    db,
    caps,
    signer: platformSigner,
    clock,
    sourceSecret: process.env.CITY_RATE_LIMIT_KEY,
    ...(options.logLine ? { log: options.logLine } : {}),
    limit,
    fail,
    owner,
    optionalOperator,
    originOf,
    mutate,
    mutateMany,
    // Late-bound: the AI workspace module registers below.
    aiCapacity: () => workspaces.capacity(),
  });
  // Mentions and wake-up (docs/WAKE.md): messaging and rooms write through wake.db so
  // their commits wake long-polls, streams and webhooks.
  const wake = createWake({
    db,
    clock,
    limit,
    // Separate wake root key: CITY_WAKE_SECRET, else an HKDF subkey of CITY_RATE_LIMIT_KEY.
    keys: wakeKeys(process.env, randomBytes(32).toString('hex')),
    retryTimer: !options.hosted,
    ...options.wake,
  });
  const messaging = createMessaging({
    db: wake.db,
    clock,
    limit,
    crossPairPerMinute: caps.crossSendsPerPairPerMinute,
    crossInboundPerMinute: caps.crossInboundSendsPerOwnerPerMinute,
    ...options.messaging,
  });
  registerMessagingRoutes(app, { messaging, owner, runtime, waitInbox: inboxWaiter(wake) });
  const workspaces = registerAiWorkspaces(app, {
    db,
    caps,
    clock,
    sourceSecret: process.env.CITY_RATE_LIMIT_KEY,
    limit,
    fail,
    person,
    owner,
    originOf,
    mutate,
    ...(options.logLine ? { log: options.logLine } : {}),
  });
  const connections = createConnections({ db, clock, caps, limit, mutateMany, mutate });
  registerConnectionRoutes(app, { connections, owner });
  // Hosted instances share CITY_RATE_LIMIT_KEY, so every instance derives the same links.
  const roomsSecret = process.env.CITY_RATE_LIMIT_KEY || randomBytes(32).toString('hex');
  const rooms = createRooms({
    db: wake.db,
    clock,
    limit,
    secret: roomsSecret,
    // Member caps from CITY_LIMIT_ROOM_MEMBERS_MAX / _DEFAULT (clamped to the protocol ceiling).
    limits: {
      memberCapMax: caps.roomMembersMax,
      memberCapDefault: caps.roomMembersDefault,
      ...options.rooms,
    },
    agentsPerWorkspace: caps.agentsPerWorkspace,
    mutate,
    mutateMany,
  });
  registerRoomRoutes(app, { rooms, owner, originOf });
  // Room tasks (docs/ROOM_TASKS.md): limits are charged before its transactions.
  const tasks = createRoomTasks({ db, clock, limit, secret: roomsSecret });
  // Owner console REST mirror of the task tools, behind the same flag (no routes when off: 404).
  if (roomTasksEnabled(process.env)) registerTaskRoutes(app, { tasks, owner, originOf });
  // Room repos (docs/ROOM_REPOS.md): GitHub App from the environment; without an
  // App id and key the tools answer 503 repos_not_configured.
  const repos = options.roomRepos
    ? options.roomRepos({ db, clock, limit })
    : createRoomReposFromEnv({
        db,
        clock,
        limit,
        // The message never contains key material; the tools answer 503 repos_not_configured.
        onConfigError: (message) =>
          (options.logLine ?? console.warn)(`room_repos.misconfigured ${message}`),
      });
  // Console REST to connect or disconnect a room's repository: host session only.
  registerRoomRepoRoutes(app, { repos, owner, originOf, fail });
  // Published results, city_ask and reuse reports (docs/ANSWERS.md).
  const results = createResults({
    db,
    clock,
    limit,
    count: (key, windowMs) => limiter.count(key, windowMs),
    limits: caps,
    options: options.results,
    appOrigins: options.hosted?.allowedOrigins ?? [],
    mutate,
  });
  registerResultRoutes(app, { results, owner, originOf });
  const links = createJoinLinks({ db, clock, limit, rooms, caps });
  registerJoinLinkRoutes(app, {
    links,
    owner,
    originOf,
    limit,
  });
  stressTestMaxGuests(); // fails startup on an invalid CITY_STRESS_TEST_MAX_GUESTS
  // "Verify here": the daily, hash-chained, signed checkpoints of the same count, public leaves,
  // owner-only inclusion proofs, and the Vercel Cron endpoint (CRON_SECRET).
  registerCountLogRoutes(app, {
    log: createCountLog({
      db,
      clock,
      excludedOperators: parseExcludedOperators(process.env.CITY_STATS_EXCLUDED_OPERATORS),
      signingKey: platformSigner.key,
    }),
    owner,
    cronSecret: process.env.CRON_SECRET,
    limit,
  });
  // Homepage ticker: AI agents that ever joined, cached per instance and at the edge.
  registerPublicStatsRoutes(app, {
    stats: createPublicStats({
      db,
      clock,
      excludedOperators: parseExcludedOperators(process.env.CITY_STATS_EXCLUDED_OPERATORS),
    }),
    limit,
  });
  const assistantAccess = await registerAssistantAccess(app, {
    db,
    messaging,
    owner,
    mutate,
    limit,
    limits: caps,
    fail,
    autonomy: autonomy.service,
    originOf,
    admitJob,
    advanceRead: advanceHostedRead,
    mutateMany,
    workspaces,
    connections,
    rooms,
    tasks,
    repos,
    wake,
    results,
  });
  const oauthServer = await registerRemoteMcp(app, {
    roomInvites: links.invites,
    db,
    access: assistantAccess,
    anonymousTool: autonomy.anonymousTool,
    createWorkspace: workspaces.createWorkspace,
    verifyWorkspaceKey: workspaces.verifyKey,
    mutate,
    limit,
    fail,
    clock,
    optionalOperator,
    authenticate,
    rememberDevice,
    hosted: options.hosted,
    secureCookies: options.hosted ? true : (options.secureCookies ?? false),
    ...options.remoteMcp,
  });
  // Hosted responder: owner settings and write-only provider keys (console session only).
  if (options.responder?.enabled ?? process.env.CITY_RESPONDER === '1') {
    const keys = responderKeys(options.responder?.env ?? process.env, {
      hosted: Boolean(options.hosted),
    });
    // The reason only (missing|invalid|not_distinct), never a value.
    if (!keys.available)
      (options.logLine ?? console.warn)(`responder.unavailable reason=${keys.reason}`);
    const responder = createResponder({
      db,
      clock,
      limit,
      mutate,
      keys,
      transport: options.responder?.transport,
    });
    registerResponderRoutes(app, { responder, owner });
    // S2b: the wake outbox drains kind 'responder' through this handler (no root key: no drain).
    if (keys.available && options.responder?.delivery !== false) {
      const delivery = createResponderDelivery({
        db: wake.db,
        clock,
        limit,
        mutate,
        keys,
        transport: options.responder?.postTransport,
        async postReply(args) {
          try {
            const result = await rooms.post(
              { operatorId: args.ownerId, actor: 'hosted responder', origin: '' },
              {
                room_id: args.roomId,
                agent_id: args.agentId,
                text: args.text,
                idempotency_key: args.idempotencyKey,
              },
              undefined,
              { autoReply: args.autoReply, precondition: args.precondition },
            );
            return { ok: true, seq: (result as { message: { seq: number } }).message.seq };
          } catch (error) {
            if (error instanceof RoomError)
              return {
                ok: false,
                code: error.errorCode,
                ...(error.statusCode === 429 && typeof error.retryAfterMs === 'number'
                  ? { retryAfterMs: error.retryAfterMs }
                  : {}),
              };
            // The shared limiter (ApiError 429) on the owner's room-post budget.
            const retry = (error as { retryAfterMs?: unknown }).retryAfterMs;
            if (typeof retry === 'number')
              return { ok: false, code: 'rate_limited', retryAfterMs: retry };
            return { ok: false, code: 'post_failed' };
          }
        },
      });
      wake.attachResponder(delivery.handle, { budgetMs: options.responder?.drainBudgetMs });
    }
  }
  registerWakeRoutes(app, {
    wake,
    db,
    messaging,
    rooms,
    access: assistantAccess,
    owner,
    runtime,
    originOf,
    limit,
    verifyWorkspaceKey: workspaces.verifyKey,
    verifyAccessToken: (token, origin) => oauthServer.verifyAccessToken(token, origin),
  });
  function workflowDetail(workspace: Workspace, workflow: StoredWorkflow): WorkflowDetail {
    return {
      workflow: publicWorkflow(workflow),
      briefJob: publicJob(ensureJob(workspace, workflow.briefJobId)),
      checkJob: workflow.checkJobId ? publicJob(ensureJob(workspace, workflow.checkJobId)) : null,
    };
  }
  function ensureWorkflow(workspace: Workspace, id: string): StoredWorkflow {
    return workspace.workflows?.find((item) => item.id === id) ?? fail(404, 'Workflow not found.');
  }
  function requireWorkflowGrants(
    workspace: Workspace,
    workflow: Pick<StoredWorkflow, 'requesterId' | 'researcherId' | 'reviewerId'>,
  ) {
    if (
      !hasPermission(workspace, {
        requesterId: workflow.requesterId,
        providerId: workflow.researcherId,
      }) ||
      !hasPermission(workspace, {
        requesterId: workflow.researcherId,
        providerId: workflow.reviewerId,
      })
    )
      fail(
        403,
        'Current requester-to-researcher and researcher-to-reviewer connections are required.',
      );
  }
  app.post('/api/workflows', async (request, reply) => {
    const operator = await owner(request),
      values = workflowSchema.parse(request.body);
    const result = await mutate(operator.id, (workspace, _tx, time) => {
      const requestHash = sha(
        canonical({
          requesterId: values.requesterId,
          researcherId: values.researcherId,
          reviewerId: values.reviewerId,
          source: values.source,
        }),
      );
      const key = `workflow:${sha(values.idempotencyKey)}`;
      const existing = workspace.workflows?.find((workflow) => workflow.idempotencyKey === key);
      requireWorkflowGrants(workspace, values);
      if (existing) {
        if (existing.requestHash !== requestHash)
          fail(409, 'This workflow idempotency key belongs to different input.');
        return workflowDetail(workspace, existing);
      }
      if (workspace.paused) fail(409, 'Workspace is paused.');
      if ((workspace.workflows?.length ?? 0) >= caps.workflowsPerWorkspace)
        fail(
          409,
          `Local workflow limit of ${caps.workflowsPerWorkspace} reached. Export retained work before continuing.`,
        );
      if (new Set([values.requesterId, values.researcherId, values.reviewerId]).size !== 3)
        fail(400, 'Choose three distinct agents.');
      const agents = [values.requesterId, values.researcherId, values.reviewerId].map((id) =>
        ensureAgent(workspace, id),
      );
      if (agents[1]!.capability !== 'research' || agents[2]!.capability !== 'verify')
        fail(400, 'Choose a research agent for the brief and a verify agent for the check.');
      if (agents.some((agent) => !reachable(agent, time)))
        fail(409, 'All three agents must be reachable.');
      const id = randomUUID();
      const briefJob = admitJob(
        workspace,
        {
          requesterId: values.requesterId,
          providerId: values.researcherId,
          input: values.source,
          idempotencyKey: `workflow:brief:${id}`,
        },
        time,
      ).job;
      const workflow: StoredWorkflow = {
        id,
        requesterId: values.requesterId,
        researcherId: values.researcherId,
        reviewerId: values.reviewerId,
        source: values.source,
        briefJobId: briefJob.id,
        checkJobId: null,
        status: 'briefing',
        createdAt: iso(time),
        updatedAt: iso(time),
        error: null,
        idempotencyKey: key,
        requestHash,
      };
      (workspace.workflows ??= []).push(workflow);
      event(
        workspace,
        time,
        'workflow.created',
        'Source brief started. Owner review is required before the check.',
        values.researcherId,
        briefJob.id,
      );
      return workflowDetail(workspace, workflow);
    });
    return reply.code(201).send(result);
  });
  app.get('/api/workflows/:id', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace) =>
      workflowDetail(workspace, ensureWorkflow(workspace, id)),
    );
  });
  app.post('/api/workflows/:id/check', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      requireWorkflowGrants(workspace, workflow);
      if (['failed', 'canceled'].includes(workflow.status))
        fail(409, 'This workflow stopped. Start a new workflow after inspecting its history.');
      if (workflow.checkJobId) return workflowDetail(workspace, workflow);
      if (workspace.paused) fail(409, 'Workspace is paused.');
      if (workflow.status !== 'awaiting_review')
        fail(409, 'Wait for the completed brief and review it before starting the check.');
      const brief = ensureJob(workspace, workflow.briefJobId);
      if (brief.status !== 'completed' || !brief.output)
        fail(409, 'The brief must contain a completed result.');
      const input = JSON.stringify({ source: workflow.source, draft: brief.output });
      if (input.length > 12000)
        fail(
          409,
          'The complete source and draft exceed the 12000-character checker limit. Nothing was truncated or sent; export the draft and start a smaller workflow.',
        );
      workflow.checkJobId = admitJob(
        workspace,
        {
          requesterId: workflow.researcherId,
          providerId: workflow.reviewerId,
          input,
          idempotencyKey: `workflow:check:${workflow.id}`,
        },
        time,
      ).job.id;
      workflow.status = 'checking';
      workflow.updatedAt = iso(time);
      event(
        workspace,
        time,
        'workflow.check_started',
        'Owner reviewed the brief and requested a check against the supplied source.',
        workflow.reviewerId,
        workflow.checkJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/workflows/:id/accept', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      if (workflow.status === 'accepted') return workflowDetail(workspace, workflow);
      requireWorkflowGrants(workspace, workflow);
      if (workflow.status !== 'completed' || !workflow.checkJobId)
        fail(409, 'Both the brief and check must finish before owner acceptance.');
      for (const jobId of [workflow.briefJobId, workflow.checkJobId]) {
        const job = ensureJob(workspace, jobId);
        if (job.status !== 'completed' || !job.output) fail(409, 'Both results must be complete.');
        if (job.acceptance !== 'accepted') {
          job.acceptance = 'accepted';
          job.acceptedAt = iso(time);
          job.updatedAt = iso(time);
        }
      }
      workflow.status = 'accepted';
      workflow.updatedAt = iso(time);
      event(
        workspace,
        time,
        'workflow.accepted',
        'Owner accepted the brief and check. No payment occurred.',
        workflow.reviewerId,
        workflow.checkJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/workflows/:id/cancel', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    z.object({}).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      const workflow = ensureWorkflow(workspace, id);
      if (['accepted', 'failed', 'canceled'].includes(workflow.status))
        return workflowDetail(workspace, workflow);
      for (const jobId of [workflow.briefJobId, workflow.checkJobId])
        if (jobId)
          stopJob(workspace, ensureJob(workspace, jobId), time, 'Owner canceled the workflow.');
      workflow.status = 'canceled';
      workflow.updatedAt = iso(time);
      workflow.error = 'Owner canceled the workflow.';
      event(
        workspace,
        time,
        'workflow.canceled',
        'Owner canceled the source brief workflow.',
        workflow.reviewerId,
        workflow.checkJobId ?? workflow.briefJobId,
      );
      return workflowDetail(workspace, workflow);
    });
  });
  app.post('/api/jobs/:id/accept', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const job = ensureJob(workspace, id);
      if (job.status !== 'completed' || !job.output)
        fail(409, 'Only a completed result can be accepted.');
      if (job.acceptance !== 'accepted') {
        job.acceptance = 'accepted';
        job.acceptedAt = iso(time);
        job.updatedAt = iso(time);
        event(
          workspace,
          time,
          'job.accepted',
          'Operator accepted the completed result. No payment occurred.',
          job.providerId,
          job.id,
        );
      }
      return { job: publicJob(job) };
    });
  });
  app.post('/api/jobs/:id/cancel', async (request) => {
    const operator = await owner(request),
      id = idFrom(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const job = ensureJob(workspace, id);
      stopJob(workspace, job, time, 'Operator canceled the job.');
      return { job: publicJob(job) };
    });
  });
  app.post('/api/workspace/pause', async (request) => {
    const operator = await owner(request),
      { paused } = z.object({ paused: z.boolean() }).strict().parse(request.body);
    return mutate(operator.id, (workspace, _tx, time) => {
      if (workspace.paused !== paused) {
        workspace.paused = paused;
        event(
          workspace,
          time,
          paused ? 'workspace.paused' : 'workspace.resumed',
          paused
            ? 'New jobs, hosted execution and result commits paused. Running external code may continue.'
            : 'Workspace execution resumed.',
        );
      }
      return { paused };
    });
  });
  app.post('/api/demo/start', async (request) => {
    const operator = await owner(request);
    return mutate(operator.id, (workspace, _tx, time) => {
      const definitions: Array<{ name: string; capability: Capability }> = [
        { name: 'Atlas', capability: 'research' },
        { name: 'Relay', capability: 'extract' },
        { name: 'Sentinel', capability: 'verify' },
      ];
      const missing = definitions.filter(
        (definition) => !workspace.agents.some((agent) => agent.demoKey === definition.name),
      );
      if (workspace.agents.length + missing.length > caps.agentsPerWorkspace)
        fail(409, 'Local agent limit reached.');
      for (const definition of missing) {
        const agent: StoredAgent = {
          id: randomUUID(),
          name: definition.name,
          description: `Hosted ${definition.capability} demonstration; deterministic local text processing.`,
          capability: definition.capability,
          mode: 'hosted',
          isDemo: true,
          createdAt: iso(time),
          lastSeenAt: null,
          revokedAt: null,
          lastSequence: -1,
          announcedOnline: false,
          demoKey: definition.name,
        };
        workspace.agents.push(agent);
        event(
          workspace,
          time,
          'agent.registered',
          `${agent.name} demonstration registered.`,
          agent.id,
        );
      }
      const demo = definitions.map((definition) =>
        workspace.agents.find((agent) => agent.demoKey === definition.name)!,
      );
      for (let index = 0; index < 2; index++) {
        const from = demo[index]!,
          to = demo[index + 1]!;
        if (from.revokedAt || to.revokedAt) continue;
        if (
          !workspace.connections.some(
            (connection) => connection.fromAgentId === from.id && connection.toAgentId === to.id,
          )
        ) {
          if (workspace.connections.length >= caps.connectionsPerWorkspace)
            fail(409, 'Local connection limit reached.');
          workspace.connections.push({
            id: randomUUID(),
            fromAgentId: from.id,
            toAgentId: to.id,
            createdAt: iso(time),
          });
          event(
            workspace,
            time,
            'connection.authorized',
            `${from.name} may request work from ${to.name}.`,
            to.id,
          );
        }
      }
      return { ok: true };
    });
  });

  app.get('/api/workspace/export', async (request, reply) => {
    const operator = await owner(request);
    reply.header('Content-Disposition', 'attachment; filename="central-city-workspace.json"');
    return mutate(operator.id, (workspace, _tx, time) =>
      exportWorkspace(workspace, operator, time),
    );
  });

  app.post('/api/runtime/a2a/:providerId', async (request, reply) => {
    const identity = await runtime(request);
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(request.params);
    if (request.headers['a2a-extensions'] !== A2A_AUTH_EXTENSION)
      throw new A2ATransportError(-32008, 'The native authentication extension is required.');
    const selection = {
      version:
        typeof request.headers['a2a-version'] === 'string'
          ? request.headers['a2a-version']
          : undefined,
      binding: A2A_PIN.binding,
    };
    const intent = parseA2AIntent(request.rawBody ?? '', selection);
    const result = await mutateRuntime(identity, (workspace, requester, time) => {
      const provider = ensureAgent(workspace, providerId);
      if (provider.mode !== 'hosted')
        fail(403, 'Agent requests are limited to hosted, zero-cost demonstrations.');
      const route = { requesterId: requester.id, providerId };
      let job: StoredJob;
      if (intent.method === 'SendMessage') {
        if (!hasPermission(workspace, route))
          fail(403, 'A current directional connection is required.');
        const admitted = admitJob(
          workspace,
          {
            ...route,
            input: intent.input.trim(),
            idempotencyKey: a2aMessageKey(requester.id, providerId, intent.messageId),
          },
          time,
          sha(
            canonical({
              profile: A2A_AUTH_EXTENSION,
              params: (request.body as { params: unknown }).params,
            }),
          ),
        );
        job = ensureJob(workspace, admitted.job.id);
      } else {
        const found = workspace.jobs.find(
          (candidate) =>
            candidate.requesterId === requester.id &&
            candidate.providerId === providerId &&
            candidate.idempotencyKey.startsWith('a2a:') &&
            a2aTaskIds(requester.id, providerId, candidate.id).taskId === intent.taskId,
        );
        if (!found) throw new A2ATransportError(-32001, 'Task not found.');
        job = found;
        if (!hasPermission(workspace, route))
          fail(403, 'The task connection is no longer authorized.');
        if (intent.method === 'CancelTask') {
          if (!active(job)) throw new A2ATransportError(-32002, 'Task is already terminal.');
          stopJob(workspace, job, time, 'Authenticated requester canceled the task.');
          job.completedAt = iso(time);
        } else advanceHostedRead(workspace, time);
      }
      const projected = publicJob(job);
      // Older native canceled/failed records did not record a terminal timestamp.
      if (['canceled', 'failed'].includes(projected.status) && !projected.completedAt)
        projected.completedAt = projected.updatedAt;
      return createTaskResponse(
        intent,
        projectNativeJob(projected, {
          ...selection,
          ...a2aTaskIds(requester.id, providerId, job.id),
        }),
      );
    });
    return reply
      .header('A2A-Version', A2A_PIN.wireVersion)
      .header('A2A-Extensions', A2A_AUTH_EXTENSION)
      .send(result);
  });

  app.post('/api/runtime/requests', async (request, reply) => {
    const identity = await runtime(request);
    const supplied = jobSchema.omit({ requesterId: true }).strict().parse(request.body);
    const response = await mutateRuntime(identity, (workspace, requester, time) => {
      const provider = ensureAgent(workspace, supplied.providerId);
      if (provider.mode !== 'hosted')
        fail(403, 'Native agent requests are limited to hosted, zero-cost demonstrations.');
      const values = { ...supplied, requesterId: requester.id };
      // Even an idempotent retrieval requires the current agent's communication grant.
      if (!hasPermission(workspace, values))
        fail(403, 'A current directional connection is required.');
      return admitJob(workspace, values, time);
    });
    return reply.code(201).send(response);
  });
  app.get('/api/runtime/requests/:id', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    return mutateRuntime(identity, (workspace, requester, time) => {
      const job = ensureJob(workspace, id);
      if (job.requesterId !== requester.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      advanceHostedRead(workspace, time);
      return { job: publicJob(job) };
    });
  });
  app.post('/api/runtime/heartbeat', async (request) => {
    const identity = await runtime(request),
      { sequence } = z
        .object({ sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) })
        .strict()
        .parse(request.body);
    // A pure heartbeat updates only the agent's presence row. The workspace row is locked and
    // rewritten only for an offline-to-online transition, which is recorded once as an event.
    const result = await db.transaction((tx) => recordHeartbeat(tx, identity, sequence, clock()));
    if (result === 'unauthorized') fail(401, 'Invalid runtime credential.');
    if (result === 'stale') fail(409, 'Heartbeat sequence must increase.');
    if (!(await announcedOnline(db, identity.operatorId, identity.agentId)))
      await mutateRuntime(identity, (workspace, agent, time) => {
        if (agent.announcedOnline || !reachable(agent, time)) return;
        agent.announcedOnline = true;
        event(
          workspace,
          time,
          'agent.online',
          `${agent.name} authenticated heartbeat received; online.`,
          agent.id,
        );
      });
    else notify(identity.operatorId);
    return { ok: true, heartbeatSeconds: 30, ttlSeconds: 90 };
  });
  app.get('/api/runtime/jobs', async (request) => {
    const identity = await runtime(request);
    return mutateRuntime(identity, (workspace, agent, time) => {
      if (workspace.paused) return { job: null };
      if (!reachable(agent, time)) fail(409, 'Send a heartbeat before claiming work.');
      recoverLeases(workspace, time);
      const job = workspace.jobs.find(
        (item) =>
          item.providerId === agent.id &&
          item.status === 'queued' &&
          hasPermission(workspace, item),
      );
      if (!job) return { job: null };
      const leaseToken = randomBytes(24).toString('base64url');
      job.status = 'running';
      job.attempts++;
      job.leaseHash = sha(leaseToken);
      job.leaseExpiresAt = time + LEASE_TTL;
      job.updatedAt = iso(time);
      event(workspace, time, 'job.started', `${agent.name} claimed the job.`, agent.id, job.id);
      return { job: publicJob(job), leaseToken };
    });
  });
  app.post('/api/runtime/jobs/:id/result', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    const { leaseToken, output } = z
      .object({ leaseToken: z.string().min(16).max(128), output: z.unknown() })
      .strict()
      .parse(request.body);
    if (!validOutput(output))
      fail(400, 'Output must be a JSON object within 32 KiB, 8 levels, and 2000 values.');
    return mutateRuntime(identity, (workspace, agent, time) => {
      const job = ensureJob(workspace, id);
      if (job.providerId !== agent.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      if (workspace.paused) fail(409, 'Workspace is paused. Retry after it resumes.');
      if (!job.leaseHash || !constantEqual(job.leaseHash, sha(leaseToken)))
        fail(409, 'Job lease is invalid.');
      const outputHash = sha(canonical(output));
      if (job.status === 'completed') {
        if (job.outputHash !== outputHash) fail(409, 'A different result was already submitted.');
        return { job: publicJob(job) };
      }
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt <= time)
        fail(409, 'Job is not running under this lease.');
      job.output = output;
      job.outputHash = outputHash;
      job.status = 'completed';
      job.completedAt = iso(time);
      job.updatedAt = iso(time);
      job.leaseExpiresAt = null;
      event(
        workspace,
        time,
        'job.completed',
        `${agent.name} submitted a result. Operator acceptance is pending.`,
        agent.id,
        job.id,
      );
      return { job: publicJob(job) };
    });
  });
  app.post('/api/runtime/jobs/:id/failure', async (request) => {
    const identity = await runtime(request),
      id = idFrom(request);
    const { leaseToken, reason } = z
      .object({
        leaseToken: z.string().min(16).max(128),
        reason: z.enum([
          'invalid-input',
          'invalid-output',
          'execution-timeout',
          'runtime-unavailable',
        ]),
      })
      .strict()
      .parse(request.body);
    const message = {
      'invalid-input': 'Provider reported invalid model input.',
      'invalid-output': 'Provider reported invalid model output.',
      'execution-timeout': 'Provider reported an execution timeout.',
      'runtime-unavailable': 'Provider reported its runtime was unavailable.',
    }[reason];
    return mutateRuntime(identity, (workspace, agent, time) => {
      const job = ensureJob(workspace, id);
      if (job.providerId !== agent.id) fail(404, 'Job not found.');
      if (!hasPermission(workspace, job)) fail(403, 'The job connection is no longer authorized.');
      if (workspace.paused) fail(409, 'Workspace is paused. Retry after it resumes.');
      if (!job.leaseHash || !constantEqual(job.leaseHash, sha(leaseToken)))
        fail(409, 'Job lease is invalid.');
      if (job.status === 'failed') {
        if (job.error !== message) fail(409, 'A different failure was already submitted.');
        return { job: publicJob(job) };
      }
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt <= time)
        fail(409, 'Job is not running under this lease.');
      job.status = 'failed';
      job.error = message;
      job.completedAt = iso(time);
      job.updatedAt = iso(time);
      job.leaseExpiresAt = null;
      event(workspace, time, 'job.failed', message, agent.id, job.id);
      return { job: publicJob(job) };
    });
  });

  function recoverLeases(workspace: Workspace, time: number): void {
    for (const job of workspace.jobs) {
      if (!active(job)) continue;
      if (!hasPermission(workspace, job)) {
        stopJob(workspace, job, time, 'Work stopped because its permission expired.');
        continue;
      }
      // Hosted server demos execute synchronously on a later request, never on an
      // outstanding external lease. A quiet client must not exhaust their retries.
      if (options.hosted && ensureAgent(workspace, job.providerId).mode === 'hosted') continue;
      if (job.status !== 'running' || job.leaseExpiresAt === null || job.leaseExpiresAt > time)
        continue;
      job.leaseHash = null;
      job.leaseExpiresAt = null;
      job.updatedAt = iso(time);
      job.status = job.attempts >= 3 ? 'failed' : 'queued';
      if (job.status === 'failed') job.completedAt = iso(time);
      job.error =
        job.status === 'failed' ? 'Pure-compute runtime lease expired after three attempts.' : null;
      event(
        workspace,
        time,
        job.status === 'failed' ? 'job.failed' : 'job.retry_queued',
        job.status === 'failed'
          ? 'Job failed after three expired pure-compute leases.'
          : 'Expired pure-compute lease returned to the queue.',
        job.providerId,
        job.id,
      );
    }
  }
  // Called only under the owner's workspace lock. Presence refresh never executes jobs.
  function refreshPresence(workspace: Workspace, time: number): void {
    for (const agent of workspace.agents) {
      if (agent.revokedAt) continue;
      if (
        agent.mode === 'hosted' &&
        (!agent.lastSeenAt || time - Date.parse(agent.lastSeenAt) >= 30_000)
      ) {
        agent.lastSeenAt = iso(time);
        agent.lastSequence++;
        // Synthetic presence refreshes silently; only the transition to online is an event.
        if (!agent.announcedOnline)
          event(workspace, time, 'agent.online', `${agent.name} hosted runtime online.`, agent.id);
        agent.announcedOnline = true;
      } else if (agent.announcedOnline && !reachable(agent, time)) {
        agent.announcedOnline = false;
        event(workspace, time, 'agent.offline', `${agent.name} heartbeat expired.`, agent.id);
      }
    }
  }
  function advanceWorkspace(workspace: Workspace, time: number): void {
    refreshPresence(workspace, time);
    recoverLeases(workspace, time);
    if (!workspace.paused) {
      const runningAtStart = workspace.jobs.filter((job) => job.status === 'running');
      for (const job of runningAtStart) {
        const provider = ensureAgent(workspace, job.providerId);
        if (provider.mode !== 'hosted' || !hasPermission(workspace, job)) continue;
        job.output = executeTemplate(job.capability, job.input);
        job.outputHash = sha(canonical(job.output));
        job.status = 'completed';
        job.completedAt = iso(time);
        job.updatedAt = iso(time);
        job.leaseExpiresAt = null;
        event(
          workspace,
          time,
          'job.completed',
          `${provider.name} completed deterministic text processing. Operator acceptance is pending.`,
          provider.id,
          job.id,
        );
      }
      for (const job of workspace.jobs) {
        const provider = ensureAgent(workspace, job.providerId);
        if (
          job.status !== 'queued' ||
          provider.mode !== 'hosted' ||
          !reachable(provider, time) ||
          !hasPermission(workspace, job)
        )
          continue;
        job.status = 'running';
        job.attempts++;
        job.updatedAt = iso(time);
        job.leaseExpiresAt = time + LEASE_TTL;
        event(
          workspace,
          time,
          'job.started',
          `${provider.name} started deterministic text processing.`,
          provider.id,
          job.id,
        );
      }
    }
  }
  function advanceHostedRead(workspace: Workspace, time: number): void {
    if (options.hosted) advanceWorkspace(workspace, time);
  }
  let tickRunning: Promise<void> | null = null;
  let closing = false;
  async function performTick(operatorId?: string): Promise<void> {
    const owners = operatorId
      ? [{ operator_id: operatorId }]
      : (await db.query<{ operator_id: string }>('SELECT operator_id FROM workspaces')).rows;
    for (const row of owners) {
      let changed = false;
      await db.transaction(async (tx) => {
        const workspace = await readWorkspace(tx, row.operator_id, true),
          time = clock();
        const before = JSON.stringify(workspace);
        syncWorkflows(workspace, time);
        advanceWorkspace(workspace, time);
        syncWorkflows(workspace, time);
        changed = before !== JSON.stringify(workspace);
        if (changed)
          await tx.query('UPDATE workspaces SET data=$2::jsonb WHERE operator_id=$1', [
            row.operator_id,
            JSON.stringify(workspace),
          ]);
      });
      if (changed) notify(row.operator_id);
    }
    await sweepExpired();
  }
  // Global expiry sweeps are throttled per instance and bounded per run. Runtime authentication
  // already removes each agent's own expired nonces, so this only reclaims idle agents' rows.
  let lastSweep = -Infinity;
  async function sweepExpired(): Promise<void> {
    const time = clock();
    if (time - lastSweep < 60_000) return;
    lastSweep = time;
    await db.query(
      'DELETE FROM replay_nonces WHERE (agent_id,nonce) IN (SELECT agent_id,nonce FROM replay_nonces WHERE expires_at<=$1 LIMIT 1000)',
      [time],
    );
    await db.query(
      'DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at<=$1 LIMIT 1000)',
      [time],
    );
    // Answers: asks, receipts and revoked tombstones older than 30 days.
    await results.sweep(time);
  }
  function tick(): Promise<void> {
    if (closing) return Promise.resolve();
    if (!tickRunning)
      tickRunning = performTick().finally(() => {
        tickRunning = null;
      });
    return tickRunning;
  }
  app.decorate('city', { tick, db });
  const interval =
    options.hosted || options.startWorkers === false
      ? undefined
      : setInterval(() => {
          void tick().catch(() => app.log.error('Worker tick failed.'));
        }, 1000);
  interval?.unref();
  app.addHook('preClose', async () => {
    closing = true;
    if (interval) clearInterval(interval);
    for (const clients of subscribers.values()) for (const reply of clients) reply.raw.end();
    subscribers.clear();
    if (tickRunning) await tickRunning;
  });
  app.addHook('onClose', async () => {
    await db.close();
    await releaseDataLock();
  });
  return app;
}
