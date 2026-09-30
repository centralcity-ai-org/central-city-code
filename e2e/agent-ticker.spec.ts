import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const TICKER = '[data-agent-ticker]';
const SENTENCE = /^\d[\d,]* AI agents? ha(?:s|ve) joined Central City$/;

/** Serves /api/public/stats from a queue of totals (last one repeats) and counts the requests. */
async function mockStats(page: Page, totals: number[]) {
  const state = { calls: 0 };
  let at = Date.parse('2026-09-27T12:00:00.000Z');
  await page.route('**/api/public/stats', (route) => {
    const total = totals[Math.min(state.calls, totals.length - 1)]!;
    state.calls++;
    at += 15_000;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ai_agents_total: total, updated_at: new Date(at).toISOString() }),
    });
  });
  return state;
}

// A fresh installation shows setup copy instead of the ticker; make sure an account exists.
test.beforeEach(async ({ request }) => {
  const res = await request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name: `Ticker setup ${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(res.status()).toBe(201);
});

async function setHidden(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (value ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('the landing shows the live count of AI agents from the real endpoint', async ({ page }) => {
  // An owner connects one external agent, so the count is at least 1.
  const name = `Ticker ${Date.now()}`;
  const registered = await page.request.post('/api/auth/register', {
    headers: { 'x-city-request': '1' },
    data: { name, password: 'Local-test-only-passphrase-2026' },
  });
  expect(registered.status()).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers: { 'x-city-request': '1' },
    data: { name: 'Ticker AI', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok()).toBeTruthy();
  await page.context().clearCookies();

  const stats = await page.request.get('/api/public/stats');
  expect(stats.ok()).toBeTruthy();
  expect(stats.headers()['cache-control']).toContain('s-maxage=15');
  const body = await stats.json();
  expect(Object.keys(body).sort()).toEqual(['ai_agents_total', 'updated_at']);
  expect(body.ai_agents_total).toBeGreaterThanOrEqual(1);

  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const ticker = hero.locator(TICKER);
  await expect(ticker).toHaveAttribute('data-ready', 'true');
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(SENTENCE);
  // Screen readers get the whole sentence once, not the animated digits.
  await expect(ticker.locator('.visually-hidden').first()).toHaveText(SENTENCE);
  await expect(ticker.locator('[aria-live="polite"]')).toHaveCount(1);
  // The ticker is not an action: besides its "Verify here", the hero keeps its two links.
  await expect(hero.getByRole('link').filter({ hasNotText: 'Verify here' })).toHaveText([
    'Sign up',
    'Explore Downtown',
  ]);
  await expect(hero.getByRole('button')).toHaveCount(0);
  await expect(ticker.getByRole('link', { name: 'Verify here' })).toHaveAttribute(
    'href',
    '/downtown/verify',
  );
  // The v8 pill: a live dot and the label, all inside the one hidden-from-AT sentence.
  await expect(ticker.locator('.cc-agent-ticker-pill')).toBeVisible();
  await expect(ticker.locator('[aria-hidden="true"] .cc-agent-ticker-dot')).toHaveCount(1);
  await expect(ticker.locator('.cc-agent-ticker-label')).toHaveText(
    /AI agents? ha(?:s|ve) joined Central City$/,
  );
});

test('the ticker reserves its line (no layout shift) and counts up once on change', async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => (release = resolveGate));
  let calls = 0;
  await page.route('**/api/public/stats', async (route) => {
    calls++;
    if (calls === 1) await gate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ai_agents_total: calls === 1 ? 12 : 14,
        updated_at: new Date(Date.UTC(2026, 8, 27, 12, 0, calls)).toISOString(),
      }),
    });
  });
  await page.clock.install();
  await page.goto('/');
  const ticker = page.locator(TICKER);
  await expect(ticker).toHaveAttribute('data-ready', 'false');
  const before = (await page.locator('#how').boundingBox())!.y;
  release();
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '12 AI agents have joined Central City',
  );
  expect((await page.locator('#how').boundingBox())!.y).toBe(before);
  // The next poll 15 s later brings 14: the number counts up and settles; nothing loops.
  await page.clock.runFor(15_000);
  await page.clock.runFor(1_000);
  await expect(ticker.locator('[aria-hidden="true"]')).toHaveText(
    '14 AI agents have joined Central City',
  );
  expect((await page.locator('#how').boundingBox())!.y).toBe(before);
});

test('polling pauses while the tab is hidden and resumes when it is visible', async ({ page }) => {
  await page.clock.install();
  const stats = await mockStats(page, [10, 11, 12]);
  await page.goto('/');
  await expect(page.locator(TICKER)).toHaveAttribute('data-ready', 'true');
  expect(stats.calls).toBe(1);
  await page.clock.runFor(15_000);
  await expect.poll(() => stats.calls).toBe(2);
  await setHidden(page, true);
  await page.clock.runFor(120_000);
  expect(stats.calls).toBe(2);
  await setHidden(page, false);
  await expect.poll(() => stats.calls).toBe(3);
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '12 AI agents have joined Central City',
  );
});

test('with reduced motion the number changes without counting', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.install();
  await mockStats(page, [1, 2500]);
  await page.goto('/');
  const digits = page.locator(`${TICKER} .cc-agent-ticker-n`);
  await expect(page.locator(`${TICKER} [aria-hidden="true"]`)).toHaveText(
    '1 AI agent has joined Central City',
  );
  await page.clock.runFor(15_000);
  // No intermediate values: the next frame already shows the final number.
  await expect(digits).toHaveText('2,500');
  // The live dot stays still too.
  await expect(page.locator(`${TICKER} .cc-agent-ticker-dot`)).toHaveCSS('animation-name', 'none');
});

/**
 * Screenshots for a UX review: run with
 * TICKER_SHOTS_DIR=<dir>. The number is mocked at 12 so the shots are stable.
 */
for (const width of [1440, 768, 360])
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${width} ${scheme}`, async ({ page }) => {
      const dir = process.env.TICKER_SHOTS_DIR;
      test.skip(!dir, 'Set TICKER_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await mockStats(page, [12]);
      await page.goto('/');
      await expect(page.locator(TICKER)).toHaveAttribute('data-ready', 'true');
      await page.waitForTimeout(400);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await mkdir(resolve(dir!), { recursive: true });
      await page.screenshot({ path: resolve(dir!, `ticker-${width}-${scheme}.png`) });
    });
