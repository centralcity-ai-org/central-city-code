import { test, expect } from '@playwright/test';

/* The docs site: /docs and its three pages. */
const PAGES = [
  { path: '/docs', h1: 'Docs' },
  { path: '/docs/start', h1: 'Connect your AI' },
  { path: '/docs/rooms', h1: 'Rooms' },
  { path: '/docs/api', h1: 'API and SDK' },
];

for (const { path, h1 } of PAGES)
  test(`${path} renders, links the other pages, and fits 360 px`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
    const nav = page.getByRole('navigation', { name: 'Docs' });
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    // The site header marks Docs as the current section.
    await expect(
      page.locator('header').getByRole('link', { name: 'Docs', exact: true }).first(),
    ).toHaveAttribute('aria-current', 'page');
    for (const title of ['Overview', 'Connect your AI', 'Rooms', 'API and SDK'])
      await expect(nav.getByRole('link', { name: title, exact: true })).toBeVisible();
    // Drafting notes never reach the site.
    const text = await page.locator('main').innerText();
    for (const marker of [
      'TODO',
      'Source:',
      'sdk-kit',
      'central-city/src',
      'central-city/docs',
      'central-city/protocol',
    ])
      expect(text, marker).not.toContain(marker);
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });

test('not-yet-live features are marked, and the facts match main', async ({ page }) => {
  await page.goto('/docs/rooms');
  const main = page.locator('main');
  await expect(main.getByText('Coming soon')).toHaveCount(1);
  await expect(main).toContainText('Up to 16,384 characters per message.');
  // People's docs name no tools; the developer page does.
  await expect(main).not.toContainText('city_');
  // 100 members per room by default, people and AIs together.
  await expect(main).toContainText('Up to 100 members per room, people and AIs together');
  await expect(main).not.toContainText('20 members per room');
  await page.goto('/docs/start');
  await expect(page.locator('main')).toContainText('ends after 90 days without use');
  await expect(page.locator('main').getByText('Coming soon')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('city_');
  await page.goto('/docs/api');
  await expect(page.locator('main')).toContainText('city_room_leave');
  await expect(page.locator('main')).toContainText(
    'A message part holds up to 16,384 characters, and a message up to 32 KB in total.',
  );
  await expect(page.locator('main')).toContainText(
    'npm install github:centralcity-ai/sdk-ts#v0.1.0-alpha.5',
  );
  await expect(page.locator('main')).toContainText('--ignore-scripts');
  await expect(page.locator('main')).toContainText('never paste them into a room');
  await expect(page.locator('main')).not.toContainText('npm install @centralcity/sdk');
});

test('the v8 sidebar: categories, section links that land on real headings, search', async ({
  page,
}) => {
  await page.goto('/docs/rooms');
  const nav = page.getByRole('navigation', { name: 'Docs' });
  for (const group of ['Getting started', 'Rooms', 'Developer reference', 'Trust'])
    await expect(nav.getByRole('group', { name: group })).toBeVisible();
  await expect(nav.locator('[aria-current="page"]')).toHaveText('Rooms');
  // Every section link points at a heading that exists on its page.
  const hrefs = await nav
    .locator('a[href*="#"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThan(10);
  for (const href of hrefs) {
    const [path, id] = href.split('#');
    await page.goto(path!);
    await expect(page.locator(`main h2[id="${id}"]`), href).toHaveCount(1);
  }
  // Search filters the links; "/" focuses it.
  await page.goto('/docs');
  const search = page.getByRole('searchbox', { name: 'Search the docs' });
  await expect(page.getByRole('heading', { level: 1, name: 'Docs' })).toBeVisible();
  await page.locator('main').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  await expect(search).toBeFocused();
  await search.fill('mention');
  await expect(nav.getByRole('link')).toHaveText(['Mentions']);
  await search.fill('zzz');
  await expect(nav).toContainText('Nothing matches');
  // People's pages name no tools, not even in the sidebar.
  await search.fill('');
  await expect(nav).not.toContainText('city_');
});

test('dark mode uses dark surfaces', async ({ page }) => {
  await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), 'dark');
  await page.goto('/docs/start');
  const luminance = await page.locator('.docs-layout').evaluate((element) => {
    const [r, g, b] = getComputedStyle(element)
      .backgroundColor.match(/\d+/g)!
      .slice(0, 3)
      .map(Number);
    return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255;
  });
  expect(luminance).toBeLessThan(0.3);
});

test('code blocks copy exactly their text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/api');
  const block = page.locator('.docs-code').filter({ hasText: 'npm install github:' });
  await block.getByRole('button', { name: /Copy/ }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'npm install github:centralcity-ai/sdk-ts#v0.1.0-alpha.5',
  );
});

/** Screenshots for a UX review: DOCS_SHOTS_DIR=<dir>. */
for (const [w, h] of [
  [1440, 900],
  [768, 1024],
  [360, 780],
] as const)
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${w} ${scheme}`, async ({ page }) => {
      const dir = process.env.DOCS_SHOTS_DIR;
      test.skip(!dir, 'Set DOCS_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width: w, height: h });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      for (const { path } of PAGES) {
        await page.goto(path);
        await page.getByRole('heading', { level: 1 }).waitFor();
        const name = path === '/docs' ? 'index' : path.split('/').pop();
        await page.screenshot({ path: `${dir}/docs-${name}-${w}-${scheme}.png`, fullPage: true });
      }
    });
