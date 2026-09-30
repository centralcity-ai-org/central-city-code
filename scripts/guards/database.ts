/**
 * Database target guards shared by load tooling (scripts/load) and, when adopted, the disposable
 * Neon harness (scripts/neon-load). Pure functions, no I/O, so they run under `pnpm test`.
 *
 * Every comparison is EXACT on a parsed identity, never a substring:
 * - a Neon host (`ep-…[-pooler].<labels>.neon.tech`) is identified by its endpoint id (`ep-…`),
 *   so the pooler and direct hostnames of one endpoint are the same identity;
 * - any other host is identified by its normalized hostname (lowercase, no trailing dot, IPv6
 *   in WHATWG canonical form), so `ep-prod-1` never matches `ep-prod-12` or `x-ep-prod-1`.
 *
 * The configured application `DATABASE_URL` (production or staging for the running shell) is
 * added to every forbidden list automatically. If it is set but cannot be identified, the guard
 * fails closed.
 */

export type DatabaseGuardCode =
  | 'TARGET_MISSING'
  | 'TARGET_INVALID'
  | 'TARGET_NOT_NEON'
  | 'TARGET_SSLMODE'
  | 'PG_ENVIRONMENT'
  | 'FORBIDDEN_LIST_MISSING'
  | 'FORBIDDEN_ENTRY_INVALID'
  | 'DATABASE_URL_UNPARSEABLE'
  | 'FORBIDDEN_ENDPOINT'
  | 'DISPOSABLE_MISSING'
  | 'DISPOSABLE_INVALID'
  | 'DISPOSABLE_BRANCH_ID'
  | 'DISPOSABLE_MISMATCH'
  | 'DATABASE_NOT_EMPTY';

const MESSAGES: Record<DatabaseGuardCode, string> = {
  TARGET_MISSING: 'A target database URL is required.',
  TARGET_INVALID:
    'The target database URL must be a postgres:// URL with a single host, no fragment, and no query parameters other than sslmode.',
  TARGET_NOT_NEON: 'The target database host must be a Neon endpoint host (ep-….neon.tech).',
  TARGET_SSLMODE: 'The target database URL must set sslmode=verify-full.',
  PG_ENVIRONMENT:
    'PGOPTIONS is set; it would add connection options (such as a Neon endpoint) after the URL was checked. Unset it.',
  FORBIDDEN_LIST_MISSING:
    'A forbidden endpoint list (the production/staging endpoints to protect) is required.',
  FORBIDDEN_ENTRY_INVALID:
    'Every forbidden endpoint entry must be an ep- id, a Neon host or a Neon postgres URL.',
  DATABASE_URL_UNPARSEABLE:
    'DATABASE_URL is set but cannot be identified, so it cannot be protected. Refusing.',
  FORBIDDEN_ENDPOINT: 'The target database points at a forbidden endpoint.',
  DISPOSABLE_MISSING: 'The disposable endpoint (ep-…) of the target branch is required.',
  DISPOSABLE_INVALID: 'The disposable endpoint must be a Neon endpoint id, host or postgres URL.',
  DISPOSABLE_BRANCH_ID:
    'A Neon branch id (br-…) cannot be verified from the connection host. Pass the endpoint id (ep-…) of the disposable branch.',
  DISPOSABLE_MISMATCH: 'The target database is not the declared disposable endpoint.',
  DATABASE_NOT_EMPTY:
    'The target database is not empty (user schemas, relations, functions or types exist). Refusing.',
};

export class DatabaseGuardError extends Error {
  readonly code: DatabaseGuardCode;
  constructor(code: DatabaseGuardCode, detail?: string) {
    super(detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code]);
    this.name = 'DatabaseGuardError';
    this.code = code;
  }
}

const fail = (code: DatabaseGuardCode, detail?: string): never => {
  throw new DatabaseGuardError(code, detail);
};

/** A parsed database identity: a Neon endpoint id, or an exact normalized hostname. */
export type DatabaseIdentity =
  { kind: 'neon'; endpointId: string } | { kind: 'host'; host: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ENDPOINT = /^ep-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const CONTROL = /[\u0000-\u001f\u007f\s]/;
const SSL_MODES = new Set(['require', 'verify-ca', 'verify-full']);

/** Lowercase, strip one trailing dot. IPv6 stays bracketed as WHATWG URL canonicalizes it. */
export function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/\.$/, '');
}

/**
 * The endpoint id of a Neon hostname, or null if the host is not a Neon endpoint host.
 * Accepts the direct and pooler forms and any number of region labels, e.g.
 * `ep-a-1.us-east-2.aws.neon.tech`, `ep-a-1-pooler.c-2.us-east-2.aws.neon.tech`.
 */
export function neonEndpointIdFromHost(host: string): string | null {
  const labels = normalizeHost(host).split('.');
  if (labels.length < 4 || labels.at(-1) !== 'tech' || labels.at(-2) !== 'neon') return null;
  if (!labels.every((label) => LABEL.test(label))) return null;
  const first = labels[0]!;
  const id = first.endsWith('-pooler') ? first.slice(0, -'-pooler'.length) : first;
  return ENDPOINT.test(id) && id.length > 3 ? id : null;
}

function identityOfHost(host: string): DatabaseIdentity | null {
  const normalized = normalizeHost(host);
  if (!normalized) return null;
  const endpointId = neonEndpointIdFromHost(normalized);
  if (endpointId) return { kind: 'neon', endpointId };
  if (normalized.startsWith('[') && normalized.endsWith(']'))
    return { kind: 'host', host: normalized };
  if (normalized.split('.').every((label) => LABEL.test(label)))
    return { kind: 'host', host: normalized };
  return null;
}

/** Parses a postgres URL strictly enough that the host we check is the host a client uses. */
export function parsePostgresUrl(value: string): URL | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || CONTROL.test(value))
    return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
  if (url.hash || !url.hostname) return null;
  // libpq-style parameters such as ?host= or ?hostaddr= would override the URL host.
  const seen = new Set<string>();
  for (const [key, parameter] of url.searchParams) {
    const name = key.toLowerCase();
    if (name !== 'sslmode' || seen.has(name) || !SSL_MODES.has(parameter.toLowerCase()))
      return null;
    seen.add(name);
  }
  return url;
}

/**
 * Identity of an endpoint id (`ep-…`, optionally `-pooler`), a hostname, or a postgres URL.
 * Returns null for anything else, including branch ids (`br-…`), which a host cannot prove.
 */
export function databaseIdentity(value: string): DatabaseIdentity | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 4096 || CONTROL.test(trimmed)) return null;
  const lower = trimmed.toLowerCase();
  if (!lower.includes('.') && !lower.includes(':') && !lower.includes('/')) {
    const id = lower.endsWith('-pooler') ? lower.slice(0, -'-pooler'.length) : lower;
    return ENDPOINT.test(id) && id.length > 3 ? { kind: 'neon', endpointId: id } : null;
  }
  if (/^postgres(?:ql)?:\/\//.test(lower)) {
    const url = parsePostgresUrl(trimmed);
    return url ? identityOfHost(url.hostname) : null;
  }
  if (lower.includes('/') || lower.includes('@')) return null;
  if (lower.startsWith('[')) {
    try {
      return identityOfHost(new URL(`postgres://${lower}/`).hostname);
    } catch {
      return null;
    }
  }
  if (lower.includes(':')) return null; // host:port or bare IPv6 without brackets: ambiguous
  return identityOfHost(lower);
}

export const sameIdentity = (a: DatabaseIdentity, b: DatabaseIdentity): boolean =>
  a.kind === 'neon' && b.kind === 'neon'
    ? a.endpointId === b.endpointId
    : a.kind === 'host' && b.kind === 'host'
      ? a.host === b.host
      : false;

export interface ForbiddenListInput {
  /** Explicit entries (endpoint ids, hosts or postgres URLs): a comma-separated string or a list. */
  explicit: string | readonly string[] | undefined;
  /** The shell's application DATABASE_URL, always protected when set. */
  databaseUrl?: string | undefined;
}

/**
 * The effective forbidden list: every explicit entry (mandatory, all must parse) plus the
 * DATABASE_URL endpoint when it is set. Returns identities only; no URL or secret is kept.
 */
export function forbiddenIdentities(input: ForbiddenListInput): DatabaseIdentity[] {
  const entries = (
    typeof input.explicit === 'string' ? input.explicit.split(',') : [...(input.explicit ?? [])]
  )
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter(Boolean);
  if (!entries.length) fail('FORBIDDEN_LIST_MISSING');
  if (entries.length > 100) fail('FORBIDDEN_ENTRY_INVALID');
  // Explicit entries must be Neon identities. Every target is a Neon endpoint, so a host-kind
  // entry (a typo such as `ep-prod-1.us-east-2`, or an alias) could never match and would
  // silently protect nothing. DATABASE_URL below may be any host: it is added, not typed.
  const identities: DatabaseIdentity[] = entries.map((entry) => {
    const identity = databaseIdentity(entry);
    return identity?.kind === 'neon' ? identity : fail('FORBIDDEN_ENTRY_INVALID');
  });
  const configured = input.databaseUrl?.trim();
  if (configured) identities.push(databaseIdentity(configured) ?? fail('DATABASE_URL_UNPARSEABLE'));
  return identities;
}

export interface NeonTargetInput {
  /** Private: never copied into errors or results. */
  targetUrl: string | undefined;
  /** Endpoint id, host or postgres URL of the disposable branch the caller intends to use. */
  disposableEndpoint: string | undefined;
  forbidden: ForbiddenListInput;
}

export interface NeonTarget {
  host: string;
  endpointId: string;
  /**
   * The exact, validated URL string. Connect with this value and nothing else (no re-reading
   * of the environment, no rebuilding), so what was checked is what is used.
   */
  databaseUrl: string;
}

/**
 * Validates a disposable Neon target: a strict postgres URL on a Neon endpoint host, exactly the
 * declared disposable endpoint, and not any forbidden identity (including DATABASE_URL).
 */
export function checkNeonTarget(input: NeonTargetInput): NeonTarget {
  if (!input.targetUrl) fail('TARGET_MISSING');
  const url = parsePostgresUrl(input.targetUrl!) ?? fail('TARGET_INVALID');
  const host = normalizeHost(url.hostname);
  const endpointId = neonEndpointIdFromHost(host) ?? fail('TARGET_NOT_NEON');
  // Require verify-full in the URL itself, so PGSSLMODE (e.g. disable) cannot weaken TLS.
  if (url.searchParams.get('sslmode')?.toLowerCase() !== 'verify-full') fail('TARGET_SSLMODE');
  const target: DatabaseIdentity = { kind: 'neon', endpointId };
  const forbidden = forbiddenIdentities(input.forbidden);
  if (forbidden.some((entry) => sameIdentity(entry, target))) fail('FORBIDDEN_ENDPOINT');
  const declared = input.disposableEndpoint?.trim();
  if (!declared) fail('DISPOSABLE_MISSING');
  if (/^br-/i.test(declared!)) fail('DISPOSABLE_BRANCH_ID');
  const declaredIdentity = databaseIdentity(declared!);
  if (!declaredIdentity || declaredIdentity.kind !== 'neon') fail('DISPOSABLE_INVALID');
  if (!sameIdentity(declaredIdentity!, target)) fail('DISPOSABLE_MISMATCH');
  return Object.freeze({ host, endpointId, databaseUrl: input.targetUrl! });
}

/**
 * libpq/node-postgres environment that can change a connection after the URL was checked.
 * `PGOPTIONS` is read by `pg` when the config has no `options`, so it could carry
 * `endpoint=<other>` to Neon's proxy. (PGSSLMODE is neutralized by requiring
 * sslmode=verify-full in the URL; PGHOST/PGPORT are ignored when the URL sets them.)
 */
export function checkPgEnvironment(env: Record<string, string | undefined>): void {
  if (env.PGOPTIONS !== undefined && env.PGOPTIONS !== '') fail('PG_ENVIRONMENT');
}

/**
 * Catalog emptiness check (the scripts/neon-load check from app #28): user schemas, relations,
 * functions and types outside pg_catalog/information_schema and not owned by an extension.
 * Run it on the target before any write; pass the single row to `assertCatalogEmpty`.
 */
export const CATALOG_EMPTY_SQL = `WITH extension_members AS (
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

export interface CatalogCounts {
  custom_schema_count: number | string;
  relation_count: number | string;
  function_count: number | string;
  type_count: number | string;
}

/** Fails closed: a missing row, a non-integer or any non-zero count means "not empty". */
export function assertCatalogEmpty(row: CatalogCounts | undefined | null): void {
  if (!row) fail('DATABASE_NOT_EMPTY', '(no catalog row)');
  const counts = [
    row!.custom_schema_count,
    row!.relation_count,
    row!.function_count,
    row!.type_count,
  ].map((value) =>
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN,
  );
  if (counts.some((count) => !Number.isSafeInteger(count) || count !== 0))
    fail('DATABASE_NOT_EMPTY');
}
