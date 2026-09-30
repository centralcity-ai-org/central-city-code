import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from './app.js';
import { isClientRoute, withoutTrailingSlash } from '../shared/routes.js';

const port = Number(process.env.PORT ?? 4310);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
// CITY_DIST_DIR is for tests (tests/routes.test.ts); normal runs serve the built dist/.
const dist = resolve(process.env.CITY_DIST_DIR ?? 'dist');
const spa = existsSync(resolve(dist, 'index.html'));
// public/404.html is copied into dist by the build; Vercel serves the same file with status 404.
const notFoundPage = existsSync(resolve(dist, '404.html'));
// Unknown paths: client routes (shared/routes.ts) get the SPA; everything else is a real 404,
// matching vercel.json. Room pages are /r/<slug>; their token stays in the fragment. Unknown
// /api/ routes are answered by createApp itself.
const app = await createApp({
  dataDir: process.env.CITY_DATA_DIR ?? resolve('.local/data'),
  notFound: (request, reply) => {
    const path = request.url.split(/[?#]/)[0]!;
    const read = request.method === 'GET' || request.method === 'HEAD';
    if (spa && read && isClientRoute(path)) return reply.type('text/html').sendFile('index.html');
    if (notFoundPage && read) return reply.code(404).type('text/html').sendFile('404.html');
    return reply.code(404).send({ error: 'Page not found' });
  },
});
if (spa) {
  await app.register(fastifyStatic, { root: dist, dotfiles: 'deny' });
}
// `/path/` → `/path` (308, query kept) for non-server-owned paths, like vercel.json's redirect
// (shared/routes.ts TRAILING_SLASH_REDIRECT).
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') return;
  const [path, ...query] = request.url.split('?');
  const target = withoutTrailingSlash(path!);
  if (target) return reply.redirect(query.length ? `${target}?${query.join('?')}` : target, 308);
});
app.addHook('onSend', async (request, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  // OAuth consent pages need same-origin so browsers send a real Origin on their form POSTs.
  reply.header(
    'Referrer-Policy',
    request.url.startsWith('/oauth/') ? 'same-origin' : 'no-referrer',
  );
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
});
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.close();
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
await app.listen({ host: '127.0.0.1', port });
console.log(`Central City is available locally at http://127.0.0.1:${port}`);
