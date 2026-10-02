import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * GET /api/deployment: which kind of deployment answers, for test runners that must refuse
 * anything but an isolated preview (e2e/rehearsal). A standalone Vercel function, served before
 * the /api rewrite. Two facts only, never a value of any other variable:
 * - `environment`: VERCEL_ENV when it is production, preview or development, else "other";
 * - `preview_db_isolated`: true only on a preview with CITY_PREVIEW_DB_ISOLATED=1 (the same
 *   condition that lets a preview migrate its own database, server/migrations.ts).
 */
export function deploymentInfo(env: Record<string, string | undefined> = process.env) {
  const kind = env.VERCEL_ENV;
  const environment =
    kind === 'production' || kind === 'preview' || kind === 'development' ? kind : 'other';
  return {
    environment,
    preview_db_isolated: environment === 'preview' && env.CITY_PREVIEW_DB_ISOLATED === '1',
  };
}

export default function handler(request: IncomingMessage, response: ServerResponse): void {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD' }).end();
    return;
  }
  response
    .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    .end(request.method === 'HEAD' ? undefined : JSON.stringify(deploymentInfo()));
}
