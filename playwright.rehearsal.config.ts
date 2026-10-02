import { randomBytes } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import { resolveE2EPort } from './e2e/port';

/*
 * The Elric staging rehearsal (the go-live test of the Elric launch checklist) as one Playwright run:
 * e2e/rehearsal/elric.rehearsal.ts. `pnpm test:rehearsal` runs it.
 *
 * - Locally (no E2E_BASE_URL): against e2e/rehearsal/server.ts, an in-memory app with a fake
 *   Google and Elric on the mock model (CITY_ELRIC_MOCK=1). Every step runs.
 * - Against a preview: E2E_BASE_URL=<the preview URL>. Steps that need something only a person
 *   can provide read it from the environment and are skipped without it (see the spec header):
 *   E2E_OWNER_STATE, E2E_OPS_SECRET, E2E_MINOR_STATE. A protected preview also needs
 *   VERCEL_AUTOMATION_BYPASS_SECRET (sent as the protection-bypass header). Nothing is committed.
 */
const remote = process.env.E2E_BASE_URL?.replace(/\/+$/, '');
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
if (remote) await guardTarget(remote);

/**
 * The hard target guard: a remote run writes accounts, rooms, usage and the kill switch, so it
 * runs only against an isolated Vercel preview. Refused: anything but https://*.vercel.app (so
 * centralcity.ai and every custom domain), and any deployment whose GET /api/deployment does not
 * report environment "preview" with preview_db_isolated (CITY_PREVIEW_DB_ISOLATED=1).
 */
async function guardTarget(base: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error(`E2E_BASE_URL is not a URL.`);
  }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.vercel\.app$/i.test(url.hostname) || url.port)
    throw new Error(
      `Refused target ${url.hostname}: only https://<deployment>.vercel.app previews.`,
    );
  const response = await fetch(new URL('/api/deployment', url), {
    headers: bypass ? { 'x-vercel-protection-bypass': bypass } : {},
    redirect: 'error',
  }).catch((error: unknown) => {
    throw new Error(
      `Refused target ${url.hostname}: /api/deployment unreachable (${String(error)}).`,
    );
  });
  const info = (await response.json().catch(() => null)) as {
    environment?: unknown;
    preview_db_isolated?: unknown;
  } | null;
  if (!response.ok || info?.environment !== 'preview' || info.preview_db_isolated !== true)
    throw new Error(
      `Refused target ${url.hostname}: it must report an isolated preview ` +
        `(status ${response.status}, ${JSON.stringify(info)}).`,
    );
}
const port = remote ? 0 : await resolveE2EPort();
process.env.E2E_REHEARSAL_FAKE_PORT ??= String(port + 1);
// A fresh operator secret per run for the local server (the runner sets it; workers inherit it).
if (!remote) process.env.E2E_OPS_SECRET ??= randomBytes(32).toString('hex');
const origin = remote ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e/rehearsal',
  testMatch: '*.rehearsal.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // A real model can be cold; locally every step takes seconds.
  timeout: remote ? 15 * 60_000 : 120_000,
  expect: { timeout: remote ? 30_000 : 10_000 },
  reporter: [['list']],
  use: {
    baseURL: origin,
    channel:
      process.env.CITY_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
    ...(bypass
      ? {
          extraHTTPHeaders: {
            'x-vercel-protection-bypass': bypass,
            'x-vercel-set-bypass-cookie': 'true',
          },
        }
      : {}),
  },
  webServer: remote
    ? undefined
    : {
        // The console UI is served from dist, so build it first.
        command:
          'node node_modules/vite/bin/vite.js build && node --import tsx e2e/rehearsal/server.ts',
        url: `${origin}/api/session`,
        reuseExistingServer: false,
        timeout: 180_000,
        env: {
          PORT: String(port),
          E2E_REHEARSAL_FAKE_PORT: process.env.E2E_REHEARSAL_FAKE_PORT,
          CITY_ELRIC: '1',
          CITY_ELRIC_MOCK: '1',
          // Elric's tool task (room_task_create) needs room tasks.
          CITY_ROOM_TASKS: '1',
          CITY_OPS_SECRET: process.env.E2E_OPS_SECRET!,
          // A tiny global ceiling: one Tier 2 reservation (8 steps of 13 units) crosses 50%.
          E2E_ELRIC_DAILY_UNITS: '200',
          CITY_LIMIT_REGISTRATIONS_PER_WINDOW: '1000',
          CITY_LIMIT_API_REQUESTS_PER_MINUTE: '100000',
        },
      },
});
