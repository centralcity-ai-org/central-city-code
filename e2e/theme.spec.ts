import { test, expect, type Page } from '@playwright/test';

/*
 * Theme: light by default on every device, whatever the OS colour-scheme setting. Dark only
 * when the visitor picks it with the theme toggle; the choice is remembered (localStorage
 * 'cc-theme') across reloads. A URL query parameter (?theme=dark|light) applies to that page
 * view only and is never stored.
 */

const LIGHT_BODY = 'rgb(255, 255, 255)';
const DARK_BODY = 'rgb(9, 9, 11)';

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function toggle(page: Page, name: 'Use dark theme' | 'Use light theme', width: number) {
  // Under 900 px the theme toggle lives in the header menu.
  if (width < 900) await page.getByRole('button', { name: 'Open menu' }).click();
  await page.getByRole('button', { name }).click();
}

for (const width of [1440, 375]) {
  test.describe(`at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height: width < 900 ? 812 : 900 });
      await page.emulateMedia({ colorScheme: 'dark' });
    });

    test('an OS dark preference still renders light', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#f4f6fa');
    });

    test('the toggle switches to dark and the choice survives a reload', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await toggle(page, 'Use dark theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBe('dark');

      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);

      // And back to light, also remembered.
      await toggle(page, 'Use light theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
    });

    test('?theme=dark applies to the view but does not change the saved choice', async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto('/?theme=dark');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
      expect(await bodyBackground(page)).toBe(LIGHT_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBeNull();

      await toggle(page, 'Use dark theme', width);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await expect.poll(() => bodyBackground(page)).toBe(DARK_BODY);
      expect(await page.evaluate(() => localStorage.getItem('cc-theme'))).toBe('dark');

      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      expect(await bodyBackground(page)).toBe(DARK_BODY);
    });

    if (width === 375) {
      test('a theme toggle mounted after navigation preserves active dark theme state', async ({
        page,
      }) => {
        await page.goto('/?theme=dark');
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

        await page.evaluate(() => history.replaceState(null, '', '/'));

        await page.getByRole('button', { name: 'Open menu' }).click();
        const toggleBtn = page.getByRole('button', { name: 'Use light theme' });
        await expect(toggleBtn).toBeVisible();
      });
    }
  });
}
