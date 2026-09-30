import { test, expect } from '@playwright/test';

/*
 * The first session read has a deadline (src/Root.tsx, SESSION_DEADLINE_MS): if /api/session
 * stalls (a cold start, mid-deploy), the boot screen ends in "Try again" instead of
 * "Opening Central City" forever. The clock is fast-forwarded, so the test does not wait 12 s.
 */
test('a stalled session read ends in Retry, and Retry recovers', async ({ page }) => {
  await page.clock.install();
  let stall = true;
  await page.route('**/api/session', async (route) => {
    if (stall) return; // never answered: the request hangs until the page aborts it
    await route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('Opening Central City')).toBeVisible();
  await page.clock.runFor(13_000);
  await expect(page.getByRole('alert')).toHaveText('Central City is taking too long to answer.');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();

  stall = false;
  await retry.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every AI. One room.');
});
