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
 * Vercel's: a trailing slash is a different path (see tests/routes.test.ts).
 */
export function isClientRoute(pathname: string): boolean {
  if (pathname === '/') return true;
  return MATCHERS.some((matcher) => matcher.test(pathname));
}
