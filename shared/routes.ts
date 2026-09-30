/**
 * The single table of client-side (SPA) paths (DESIGN_SYSTEM §3, decisions D3/E7, item O3).
 *
 * - server/index.ts serves index.html for exactly these paths and a real 404 for anything else.
 * - vercel.json has one explicit rewrite per entry (`vercelSource`) to /index.html; unmatched
 *   paths get public/404.html with status 404. tests/routes.test.ts keeps the two in parity.
 * - The SPA router should import `isClientRoute` too, so all three agree.
 *
 * Server-owned paths are deliberately absent and keep their own vercel.json rewrites: /api,
 * /mcp, /oauth, /.well-known, /a2a and /j (the join-link page, whose code must never reach a
 * query string or the SPA). "/" is served as the static index.html and needs no rewrite.
 */

/** One path segment: letters, digits, `_` and `-`, up to 64 characters (no dots, so no files). */
const SEGMENT = '[A-Za-z0-9_-]{1,64}';

export interface ClientRoute {
  /** Documentation form, e.g. `/rooms/:id`. */
  readonly path: string;
  /** The vercel.json rewrite source (path-to-regexp, unnamed groups for parameters). */
  readonly vercelSource: string;
}

function route(path: string): ClientRoute {
  if (!/^(?:\/(?:[a-z][a-z0-9-]*|:[a-z]+))+$/.test(path)) throw new Error(`Bad route: ${path}`);
  return Object.freeze({ path, vercelSource: path.replace(/:[a-z]+/g, `(${SEGMENT})`) });
}

/** Every client path except "/", in the order of DESIGN_SYSTEM §3. */
export const CLIENT_ROUTES: readonly ClientRoute[] = Object.freeze([
  route('/how'),
  route('/about'),
  route('/signin'),
  route('/invite'),
  // Legacy path still served by the current SPA; `/#connect` and `/connect` move to /invite (E6).
  route('/connect'),
  route('/r/:slug'),
  route('/rooms'),
  route('/rooms/:id'),
  route('/agents'),
  route('/agents/:id'),
  route('/answers'),
  // Result permalinks: the same shell for every id; nothing is revealed signed out (A6).
  route('/results/:id'),
  route('/settings'),
  route('/settings/:tab'),
  route('/downtown'),
  // Trust pages (DESIGN_SYSTEM §2.2 Trust column), public, no session.
  route('/privacy'),
  route('/terms'),
  route('/security'),
  route('/support'),
  // Footer pages: help, policies and company, public, no session.
  route('/status'),
  route('/privacy-choices'),
  route('/acceptable-use'),
  route('/dpa'),
  route('/imprint'),
  route('/contact'),
  // The verifiable agent count ("Verify here" on the homepage ticker).
  route('/downtown/verify'),
  // The docs site.
  route('/docs'),
  route('/docs/start'),
  route('/docs/rooms'),
  route('/docs/api'),
]);

const MATCHERS = CLIENT_ROUTES.map(
  (entry) => new RegExp(`^${entry.path.replace(/:[a-z]+/g, SEGMENT)}$`),
);

/**
 * True when `pathname` (no query or fragment) is a client route. Matching is exact, like
 * Vercel's: a trailing slash is a different path, which TRAILING_SLASH_REDIRECT sends to the path
 * without it (see tests/routes.test.ts).
 */
export function isClientRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return MATCHERS.some((matcher) => matcher.test(pathname));
}

/**
 * `/path/` → `/path` (308, the query string kept) for every non-root path that is not
 * server-owned. vercel.json has this exact rule (`redirects`); server/index.ts applies
 * `withoutTrailingSlash` for local and e2e parity.
 *
 * - Server-owned prefixes (/api, /mcp, /oauth, /.well-known, /a2a, /j) are never redirected: their
 *   paths stay exactly as clients send them.
 * - Files (a last segment with a dot, e.g. /docs/room-tasks.md) are never redirected.
 * - The path must start with a letter or digit and have no empty segments, so the target can never
 *   be `//host` or `/\host` (no open redirect). "/" is not matched.
 */
const SERVER_OWNED = '(?:api|mcp|oauth|\\.well-known|a2a|j)(?:/|$)';
// One segment starting with a letter or digit, then more segments; the last has no dot. Only
// lookaheads and non-capturing groups, which both vercel.json (path-to-regexp) and JS accept.
const REDIRECTABLE = `(?!${SERVER_OWNED})[A-Za-z0-9](?:[^/.]*|[^/]*(?:/[^/]+)*/[^/.]+)`;

export const TRAILING_SLASH_REDIRECT = Object.freeze({
  source: `/:path(${REDIRECTABLE})/`,
  destination: '/:path',
  permanent: true,
});

const TRAILING = new RegExp(`^/(${REDIRECTABLE})/$`);

/** The redirect target for `pathname` (no query), or null when it keeps its path. */
export function withoutTrailingSlash(pathname: string): string | null {
  const match = TRAILING.exec(pathname);
  return match ? `/${match[1]}` : null;
}
