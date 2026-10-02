import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import { createApp } from '../../server/app.js';
import { isClientRoute } from '../../shared/routes.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
} from '../../tests/fake-google.js';

/*
 * The local server for the Elric staging rehearsal (e2e/rehearsal/elric.rehearsal.ts, run by
 * playwright.rehearsal.config.ts). Like e2e/google-server.ts: the app with Sign in with Google on
 * and a fake Google injected through createApp options, Elric on the mock model (CITY_ELRIC=1,
 * CITY_ELRIC_MOCK=1 from the environment), plus a fake consent page on its own port. Two
 * rehearsal-only additions:
 *
 * - the fake consent page signs in the Google subject the spec names (`e2e_sub`), so one run can
 *   link several Google accounts (an adult owner, a minor, the same minor again);
 * - a small global ceiling (E2E_ELRIC_DAILY_UNITS) so the 50% ceiling alert is reachable, and the
 *   alert log lines are collected and served at GET /alerts on the fake page's port.
 *
 * Test-only: it refuses to start on a deployment.
 */
if (
  process.env.CITY_HOSTED === '1' ||
  process.env.VERCEL === '1' ||
  process.env.NODE_ENV === 'production' ||
  process.env.DATABASE_URL
)
  throw new Error('The rehearsal e2e server runs only locally, in memory.');
const port = Number(process.env.PORT);
const fakePort = Number(process.env.E2E_REHEARSAL_FAKE_PORT);
if (!Number.isInteger(port) || !Number.isInteger(fakePort)) throw new Error('Set the e2e ports.');
const dailyUnits = Number(process.env.E2E_ELRIC_DAILY_UNITS ?? '200');
if (!Number.isInteger(dailyUnits) || dailyUnits < 1) throw new Error('Bad E2E_ELRIC_DAILY_UNITS.');

// The ceiling alert sink logs one JSON line per crossing (server/elric/ops.ts); keep them.
const alerts: unknown[] = [];
const warn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const line = args[0];
  if (typeof line === 'string' && line.includes('"event":"elric_ceiling_alert"'))
    try {
      alerts.push(JSON.parse(line));
    } catch {
      // not JSON: ignore
    }
  warn(...args);
};

const google = fakeGoogle();
const dist = resolve('dist');
const spa = existsSync(resolve(dist, 'index.html'));
const app = await createApp({
  dataDir: 'memory://',
  google: {
    env: {
      CITY_GOOGLE_SIGNIN: '1',
      GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    },
    transport: google.transport,
  },
  elric: { config: { globalDailyUnits: dailyUnits } },
  notFound: (request, reply) => {
    const path = request.url.split(/[?#]/)[0]!;
    if (spa && request.method === 'GET' && isClientRoute(path))
      return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({ error: 'Page not found' });
  },
});
if (spa) await app.register(fastifyStatic, { root: dist, dotfiles: 'deny' });
await app.listen({ host: '127.0.0.1', port });

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${fakePort}`);
  if (url.pathname === '/alerts') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(alerts));
    return;
  }
  const nonce = url.searchParams.get('nonce');
  const state = url.searchParams.get('state');
  const challenge = url.searchParams.get('code_challenge');
  const redirect = url.searchParams.get('redirect_uri');
  const sub = url.searchParams.get('e2e_sub') ?? '100000000000000000001';
  if (
    url.pathname !== '/authorize' ||
    !nonce ||
    !state ||
    !challenge ||
    !/^\d{6,30}$/.test(sub) ||
    redirect !== `http://127.0.0.1:${port}/api/auth/google/callback`
  ) {
    response.writeHead(400).end();
    return;
  }
  const claims = claimsFor(nonce, Date.now(), {
    sub,
    email: `synthetic.${sub.slice(-6)}@gmail.com`,
  });
  const code = google.issueCode(signIdToken(google.keys[0]!, claims), challenge);
  response
    .writeHead(302, { location: `${redirect}?${new URLSearchParams({ state, code })}` })
    .end();
}).listen(fakePort, '127.0.0.1');
console.log(`Rehearsal e2e server at http://127.0.0.1:${port}`);
