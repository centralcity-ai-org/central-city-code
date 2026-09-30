/**
 * Safety guards for load targets. Pure functions (no I/O) so they run under `pnpm test`.
 *
 * Local runs use an in-process PGlite database only. A Neon run must point at exactly the
 * disposable endpoint named on the command line (`--disposable-endpoint=ep-…`), on a Neon
 * endpoint host that is not a forbidden endpoint (LOAD_FORBIDDEN_ENDPOINTS plus the shell's
 * DATABASE_URL, added automatically), never at a public application origin, and the database
 * must be catalog-empty. Host and endpoint parsing is shared with scripts/guards/database.ts:
 * every comparison is exact, never a substring.
 */

import {
  assertCatalogEmpty,
  checkNeonTarget as checkNeonDatabaseTarget,
  checkPgEnvironment,
  DatabaseGuardError,
  neonEndpointIdFromHost,
  type CatalogCounts,
  type DatabaseGuardCode,
} from '../guards/database.js';

export { CATALOG_EMPTY_SQL } from '../guards/database.js';

export type LoadTarget = 'local' | 'neon';

export class GuardError extends Error {
  /** Set when the refusal comes from the shared database guards. */
  readonly code?: DatabaseGuardCode;
  constructor(message: string, code?: DatabaseGuardCode) {
    super(message);
    this.name = 'GuardError';
    this.code = code;
  }
}

/** The load setting an operator must fix for each shared guard refusal. */
const LOAD_SETTING: Partial<Record<DatabaseGuardCode, string>> = {
  TARGET_MISSING: 'LOAD_DATABASE_URL',
  TARGET_INVALID: 'LOAD_DATABASE_URL',
  TARGET_NOT_NEON: 'LOAD_DATABASE_URL',
  TARGET_SSLMODE: 'LOAD_DATABASE_URL',
  PG_ENVIRONMENT: 'PGOPTIONS',
  FORBIDDEN_LIST_MISSING: 'LOAD_FORBIDDEN_ENDPOINTS',
  FORBIDDEN_ENTRY_INVALID: 'LOAD_FORBIDDEN_ENDPOINTS',
  DATABASE_URL_UNPARSEABLE: 'DATABASE_URL',
  FORBIDDEN_ENDPOINT: 'LOAD_DATABASE_URL',
  DISPOSABLE_MISSING: '--disposable-endpoint',
  DISPOSABLE_INVALID: '--disposable-endpoint',
  DISPOSABLE_BRANCH_ID: '--disposable-endpoint',
  DISPOSABLE_MISMATCH: '--disposable-endpoint',
};

/** Runs a shared database guard, keeping its code but reporting it as a load GuardError. */
function guarded<T>(check: () => T): T {
  try {
    return check();
  } catch (error) {
    if (error instanceof DatabaseGuardError) {
      const setting = LOAD_SETTING[error.code];
      throw new GuardError(setting ? `${error.message} (${setting})` : error.message, error.code);
    }
    throw error;
  }
}

/** Application origins that load must never reach, whatever the flags say. */
export const FORBIDDEN_HOST_SUFFIXES = ['centralcity.ai', 'vercel.app'] as const;

export function parseTarget(value: string | undefined): LoadTarget {
  if (value === 'local' || value === 'neon') return value;
  throw new GuardError('--target must be "local" or "neon".');
}

const hostMatches = (host: string, suffix: string) =>
  host === suffix || host.endsWith(`.${suffix}`);

/** Hosts of every URL-looking value in the input (origins, connection strings). */
function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuses a public application origin: centralcity.ai, *.vercel.app, or the configured
 * production origin (LOAD_PRODUCTION_ORIGIN / CITY_PUBLIC_ORIGIN).
 */
export function assertNotProductionOrigin(
  value: string,
  productionOrigins: readonly string[] = [],
): void {
  const host = hostOf(value) ?? value.toLowerCase();
  for (const suffix of FORBIDDEN_HOST_SUFFIXES)
    if (hostMatches(host, suffix) || value.toLowerCase().includes(suffix))
      throw new GuardError(`Refusing load against ${suffix}.`);
  for (const origin of productionOrigins) {
    const production = hostOf(origin) ?? origin.toLowerCase();
    if (production && hostMatches(host, production))
      throw new GuardError('Refusing load against the production origin.');
  }
}

export interface NeonGuardInput {
  databaseUrl: string | undefined;
  /** Comma-separated endpoint ids, hosts or postgres URLs from LOAD_FORBIDDEN_ENDPOINTS. */
  forbiddenEndpoints: string | undefined;
  /**
   * Value of --disposable-endpoint=<ep-id> (or the older --disposable-branch flag). It must be
   * the target's endpoint id or host, matched exactly. A `br-` branch id is refused: the
   * connection host cannot prove which branch it belongs to.
   */
  disposableBranch: string | undefined;
  /** The shell's application DATABASE_URL: always added to the forbidden list when set. */
  applicationDatabaseUrl?: string | undefined;
  /** Production origins that must never be targeted (LOAD_PRODUCTION_ORIGIN, CITY_PUBLIC_ORIGIN). */
  productionOrigins?: readonly string[];
}

/**
 * Neon endpoint id of a host: `ep-x-123.region.aws.neon.tech` / `ep-x-123-pooler…` → `ep-x-123`.
 * Returns '' for a host that is not a Neon endpoint host.
 */
export function neonEndpointId(host: string): string {
  return neonEndpointIdFromHost(host) ?? '';
}

/** Validates a Neon target. Returns the host, endpoint id and the exact validated URL. */
export function checkNeonTarget(input: NeonGuardInput): {
  host: string;
  endpoint: string;
  databaseUrl: string;
} {
  if (!input.databaseUrl) throw new GuardError('LOAD_DATABASE_URL is required for --target=neon.');
  assertNotProductionOrigin(input.databaseUrl, input.productionOrigins ?? []);
  const { host, endpointId, databaseUrl } = guarded(() =>
    checkNeonDatabaseTarget({
      targetUrl: input.databaseUrl,
      disposableEndpoint: input.disposableBranch,
      forbidden: { explicit: input.forbiddenEndpoints, databaseUrl: input.applicationDatabaseUrl },
    }),
  );
  return { host, endpoint: endpointId, databaseUrl };
}

/**
 * The target database must be empty in the catalog sense (app #28's check): no user schemas,
 * relations, functions or types. Run CATALOG_EMPTY_SQL on the target and pass its row. This
 * replaces the earlier operator-name check, which a database with real data but no `operators`
 * rows (or with `load-` named operators) could pass.
 */
export function checkDatabaseEmpty(row: CatalogCounts | undefined | null): void {
  guarded(() => assertCatalogEmpty(row));
}

/** Full pre-flight for a run. Local needs nothing; neon validates and then (for now) refuses. */
export function preflight(
  target: LoadTarget,
  env: NodeJS.ProcessEnv,
  flags: Record<string, string>,
): Readonly<{ host?: string; endpoint?: string; databaseUrl?: string }> {
  if (target === 'local') return {};
  // A Neon runner must connect with the returned `databaseUrl` exactly as validated here
  // Never re-read LOAD_DATABASE_URL or rebuild the URL after preflight.
  guarded(() => checkPgEnvironment(env));
  const productionOrigins = [env.LOAD_PRODUCTION_ORIGIN, env.CITY_PUBLIC_ORIGIN].filter(
    (value): value is string => Boolean(value),
  );
  const checked = checkNeonTarget({
    databaseUrl: env.LOAD_DATABASE_URL,
    forbiddenEndpoints: env.LOAD_FORBIDDEN_ENDPOINTS,
    disposableBranch: flags['disposable-endpoint'] ?? flags['disposable-branch'],
    applicationDatabaseUrl: env.DATABASE_URL,
    productionOrigins,
  });
  return Object.freeze({ ...checked });
}
