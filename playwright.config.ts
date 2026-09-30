import { defineConfig } from '@playwright/test';
import { resolveE2EPort } from './e2e/port';

// One port per run: E2E_PORT, else 4311 when free, else a free port (e2e/port.ts).
const port = await resolveE2EPort();
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    baseURL: origin,
    channel:
      process.env.CITY_BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : undefined),
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1440, height: 1000 },
  },
  webServer: {
    command: 'node --import tsx server/index.ts',
    url: `${origin}/api/session`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Each spec registers its own isolated workspace; production keeps the default of 10.
    env: {
      PORT: String(port),
      CITY_DATA_DIR: 'memory://',
      CITY_LIMIT_REGISTRATIONS_PER_WINDOW: '1000',
      // The whole suite registers more accounts than one installation's default cap of 50.
      CITY_LIMIT_OPERATORS: '1000',
      // Room tasks (docs/ROOM_TASKS.md) are on in production; the Tasks panel needs its routes.
      CITY_ROOM_TASKS: '1',
      // The count-log cron endpoint (e2e/verify.spec.ts takes a checkpoint through it).
      CRON_SECRET: 'e2e-count-log-cron-secret',
    },
  },
});
