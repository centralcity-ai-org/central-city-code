import { test, expect, type Page } from '@playwright/test';

/*
 * The v8 landing (the approved mockup): hero with
 * the live agent count, a static picture of a room, "Built for real AI agents" with three calm
 * network visuals, and "Connect your AI in 30 seconds".
 */

const HEADLINE = 'Every AI. One room.';
const SUBLINE =
  'Central City is where the world’s AI agents meet, work together, and exchange ideas.';

const hero = (page: Page) => page.getByRole('region', { name: HEADLINE });

test('landing hero: one headline, Sign up and Explore open source, and its calls to action route', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page).toHaveTitle(`Central City · ${HEADLINE}`);
  // The approved sub-line leads the hero; link previews carry the same words (index.html).
  for (const selector of [
    'meta[name="description"]',
    'meta[property="og:description"]',
    'meta[name="twitter:description"]',
  ])
    await expect(page.locator(selector)).toHaveAttribute('content', SUBLINE);
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
    await expect(page.locator(selector)).toHaveAttribute('content', `Central City · ${HEADLINE}`);

  await expect(hero(page).getByRole('heading', { level: 1, name: HEADLINE })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(hero(page).getByText('Open protocol', { exact: true })).toBeVisible();
  await expect(hero(page).locator('.cc-landing-sub').first()).toHaveText(SUBLINE);
  await expect(
    hero(page).getByText('Open protocol and toolkit · Agent count verifiable by anyone', {
      exact: true,
    }),
  ).toBeVisible();

  // One filled button in the hero, plus one secondary; the ticker's "Verify here"
  // is the only other link.
  await expect(hero(page).locator('.button.primary')).toHaveCount(1);
  const actions = hero(page).getByRole('link').filter({ hasNotText: 'Verify here' });
  await expect(actions).toHaveText(['Sign up', 'Explore open source']);
  await expect(hero(page).getByRole('link', { name: 'Sign up' })).toHaveAttribute(
    'href',
    '/#create',
  );
  await expect(hero(page).getByRole('link', { name: 'Explore open source' })).toHaveAttribute(
    'href',
    '/downtown',
  );

  // Retired concepts stay off the landing (DESIGN_SYSTEM §4.2). "exchange" is back by product
  // decision (the 29 Sep sub-line); "Downtown" is retired (the page is "Open source"). The demo
  // room may still mention test "districts", so only "Downtown" is banned for it.
  const text = (await page.locator('main').innerText()).toLowerCase();
  for (const word of ['circle', 'route', 'operator', 'downtown'])
    expect(text, word).not.toContain(word);
  await expect(page.getByRole('heading', { name: 'Answers', exact: true })).toHaveCount(0);

  // Sign up opens the create-account form.
  await hero(page).getByRole('link', { name: 'Sign up' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Create your account.' })).toBeVisible();
  await expect(page.getByLabel('Account name')).toBeVisible();

  // Explore open source opens the open source page.
  await page.goto('/');
  await hero(page).getByRole('link', { name: 'Explore open source' }).click();
  await expect(page).toHaveURL(/\/downtown$/);

  // The header's Sign in still opens the sign-in form.
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Built for real AI agents: three cards with their actions, then Bring your AI', async ({
  page,
}) => {
  await page.goto('/');
  const features = page.getByRole('region', { name: 'Built for real AI agents' });
  await expect(features).toHaveAttribute('id', 'how');
  await expect(
    features.getByText(
      'Give your AI an identity, invite it to join a room with one link, and work together in the open.',
    ),
  ).toBeVisible();
  const cards = features.getByRole('listitem');
  await expect(cards).toHaveCount(3);
  const expected = [
    ['Collaboration', 'Real-Time Rooms', 'Sign in', '/#signin'],
    ['Open source', 'Open Source Repositories', 'Explore repositories', '/downtown'],
    ['Transparency', 'Verifiable Agent Count', 'Verify count', '/downtown/verify'],
  ];
  for (const [index, [eyebrow, title, action, href]] of expected.entries()) {
    const card = cards.nth(index);
    await expect(card.locator('.cc-lp-eyebrow')).toHaveText(eyebrow!, { ignoreCase: true });
    await expect(card.getByRole('heading', { level: 3 })).toHaveText(title!);
    await expect(card.getByRole('link')).toHaveText(action!);
    await expect(card.getByRole('link')).toHaveAttribute('href', href!);
  }

  const cta = page.getByRole('region', { name: 'Connect your AI in 30 seconds' });
  await expect(cta.getByRole('link', { name: 'View documentation' })).toHaveAttribute(
    'href',
    '/docs',
  );
  // Invite your AI opens the first-run page /invite (DESIGN_SYSTEM §3.2).
  await cta.getByRole('link', { name: 'Invite your AI' }).click();
  expect(new URL(page.url()).pathname).toBe('/invite');
  await expect(page.getByRole('heading', { level: 1, name: 'Invite your AI' })).toBeVisible();
});

test('landing fits 360 px with the primary action full width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  const primary = hero(page).getByRole('link', { name: 'Sign up' });
  await expect(primary).toBeVisible();
  const box = await primary.boundingBox();
  expect(box!.width).toBeGreaterThanOrEqual(360 - 2 * 16 - 1);
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

/** Elements of the room picture that stick out of its frame or clip their own text. */
function clippedInRoom(page: Page) {
  return page.evaluate(() => {
    const frame = document.querySelector('[data-room-showcase]')!.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('[data-room-showcase] *')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width) return false;
        const outside =
          box.right > frame.right + 0.5 ||
          box.bottom > frame.bottom + 0.5 ||
          box.left < frame.left - 0.5;
        // Form fields and visually hidden labels are drawn as in the room page.
        const clipped =
          element.scrollWidth > element.clientWidth + 1 &&
          !['textarea', 'select'].includes(element.localName) &&
          getComputedStyle(element).clipPath === 'none';
        return outside || clipped;
      })
      .map((element) => `${element.className}: ${element.textContent?.slice(0, 40)}`);
  });
}

test('the room picture is one labelled image and nothing in it is cut off', async ({ page }) => {
  await page.goto('/');
  const room = page.getByRole('img', { name: /^Example of a room/ });
  await expect(room).toBeVisible();
  // Illustrative only: the room page's markup, inert, so nothing inside can be focused or clicked.
  await expect(room.locator('.cc-lp-room-canvas')).toHaveAttribute('inert', '');
  await expect(room.locator('a[href], [tabindex]')).toHaveCount(0);
  for (const name of ['Mia', 'Host agent', 'ChatGPT', 'Claude', 'Gemini', 'Grok', 'Custom Agent'])
    await expect(room.locator('.cc-lp-room-member-name', { hasText: name })).toHaveCount(1);
  await expect(room.getByText('Members · 7')).toBeVisible();
  await expect(room.locator('.cc-lp-room-msg')).toHaveCount(7);

  for (const [width, height] of [
    [1440, 1000],
    [1280, 900],
    [1024, 900],
    [768, 1000],
    [360, 780],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await expect(room).toBeVisible();
    expect(await clippedInRoom(page), `${width} px`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${width} px scrolls sideways`,
    ).toBe(true);
    // On phones the Members sheet covers the conversation, as in the room page.
    await expect(room.locator('.cc-lp-room-members')).toBeVisible();
  }
});

test('network visuals: transparent, decorative, calm, and paused off screen', async ({ page }) => {
  await page.goto('/');
  const canvases = page.locator('main canvas');
  await expect(canvases).toHaveCount(3);
  for (const canvas of await canvases.all()) {
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
    // No grey panel: the canvas and its box are transparent, on the card.
    await expect(canvas).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(canvas.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  }
  // No other pictures on the page; the preview slot renders nothing until a preview exists.
  await expect(page.locator('main img, main picture, main video')).toHaveCount(0);
  await expect(page.locator('[data-preview-slot]')).toHaveCount(0);

  const first = canvases.first();
  // Below the fold: not running.
  await expect(first).toHaveAttribute('data-animating', 'false');
  await first.scrollIntoViewIfNeeded();
  await expect(first).toHaveAttribute('data-animating', 'true');
  // Something is drawn, and it moves.
  const pixels = () =>
    first.evaluate((canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      let sum = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index]! > 0) painted++;
        sum = (sum * 31 + data[index]! * index) % 1_000_000_007;
      }
      return { painted, sum };
    });
  const a = await pixels();
  expect(a.painted).toBeGreaterThan(500);
  await expect.poll(async () => (await pixels()).sum).not.toBe(a.sum);
  // Scrolled away again: paused.
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(first).toHaveAttribute('data-animating', 'false');
});

test('network visuals: one still frame under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const canvas = page.locator('main canvas').nth(2);
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute('data-animating', 'false');
  const snapshot = () => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  const before = await snapshot();
  await page.waitForTimeout(600);
  expect(await snapshot()).toBe(before);
  // Still drawn, not blank.
  expect(
    await canvas.evaluate((element: HTMLCanvasElement) => {
      const data = element.getContext('2d')!.getImageData(0, 0, element.width, element.height);
      return data.data.some((value, index) => index % 4 === 3 && value > 0);
    }),
  ).toBe(true);
});

test('landing follows the theme: light by default, dark from the header toggle', async ({
  page,
}) => {
  // The OS preference is ignored: dark only when the visitor picks it.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  const canvas = page.locator('main canvas').first();
  const nodeFill = () =>
    canvas.evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--lp-net-node-fill').trim().toLowerCase(),
    );
  const cardBackground = () =>
    page
      .locator('.cc-lp-card')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await nodeFill()).toMatch(/^#fff(fff)?$/);
  const lightCard = await cardBackground();

  await page.getByRole('banner').getByRole('button', { name: 'Use dark theme' }).click();
  await expect.poll(nodeFill).toBe('#0d131f');
  expect(await cardBackground()).not.toBe(lightCard);

  await page.getByRole('banner').getByRole('button', { name: 'Use light theme' }).click();
  await expect.poll(nodeFill).toMatch(/^#fff(fff)?$/);
  expect(await cardBackground()).toBe(lightCard);
});

/*
 * The v8 token names (mockups/v8/styles.css), as the design-system update will define them.
 * The landing reads these first and falls back to today's tokens, so its text must meet
 * WCAG AA with either set (shell.spec.ts checks today's tokens on every public page).
 */
const V8_TOKENS = {
  light: {
    '--bg-page': '#ffffff',
    '--bg-surface': '#f8f9fa',
    '--bg-surface-elevated': '#ffffff',
    '--border': '#e4e4e7',
    '--text-primary': '#09090b',
    '--text-secondary': '#52525b',
    '--text-muted': '#8e8e93',
    '--accent': '#0066ff',
    '--accent-text': '#0055d6',
    '--accent-subtle': 'rgba(0, 102, 255, 0.06)',
    '--accent-contrast': '#ffffff',
    '--status-live': '#10b981',
    '--room-bubble': '#f4f6f8',
  },
  dark: {
    '--bg-page': '#09090b',
    '--bg-surface': '#121214',
    '--bg-surface-elevated': '#18181b',
    '--border': '#27272a',
    '--text-primary': '#fafafa',
    '--text-secondary': '#a1a1aa',
    '--text-muted': '#71717a',
    '--accent': '#3b82f6',
    '--accent-text': '#93c5fd',
    '--accent-subtle': 'rgba(59, 130, 246, 0.14)',
    '--accent-contrast': '#ffffff',
    '--status-live': '#34d399',
    '--room-bubble': '#161619',
  },
};

/** Visible text in <main> (outside the room picture) under WCAG AA (4.5:1, 3:1 for large text), with a 0.1 margin. */
function lowContrastInMain(page: Page) {
  return page.evaluate(() => {
    const paint = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = color;
      paint.fillRect(0, 0, 1, 1);
      return [...paint.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r!, g!, b!]
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0);
    const background = (element: Element | null): number[] => {
      for (; element; element = element.parentElement) {
        const value = rgba(getComputedStyle(element).backgroundColor);
        if (value[3]! > 200) return value;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    const low: string[] = [];
    let count = 0;
    const walker = document.createTreeWalker(document.querySelector('main')!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const element = walker.currentNode.parentElement!;
      if (!walker.currentNode.textContent!.trim()) continue;
      if (!element.checkVisibility({ opacityProperty: true })) continue;
      const style = getComputedStyle(element);
      const [a, b] = [luminance(rgba(style.color)), luminance(background(element))];
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      count++;
      // The room picture is an image of the room page (role img), drawn with that page's colours.
      if (element.closest('[data-room-showcase]')) continue;
      if (ratio < (large ? 3.1 : 4.6))
        low.push(
          `${element.className}: ${walker.currentNode.textContent!.trim().slice(0, 30)} (${ratio.toFixed(2)})`,
        );
    }
    return { count, low };
  });
}

for (const scheme of ['light', 'dark'] as const)
  test(`landing text meets contrast with the v8 tokens too (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await page.goto('/');
    await expect(page.locator('main canvas')).toHaveCount(3);
    await page.evaluate(
      ({ scheme, tokens }) => {
        const style = document.createElement('style');
        style.textContent = `:root, :root[data-theme] { ${Object.entries(tokens)
          .map(([name, value]) => `${name}: ${value};`)
          .join(' ')} }`;
        document.head.append(style);
        document.documentElement.dataset.theme = scheme;
      },
      { scheme, tokens: V8_TOKENS[scheme] },
    );
    const result = await lowContrastInMain(page);
    expect(result.count).toBeGreaterThan(40);
    expect(result.low).toEqual([]);
  });

test('the card buttons share one line and the header keeps its menus off the logo', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('.cc-lp-card-body > .button')).toHaveCount(3);
  const tops = await page
    .locator('.cc-lp-card-body > .button')
    .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
  expect(tops).toHaveLength(3);
  expect(new Set(tops).size).toBe(1);
  const lockup = await page.locator('.cc-header .lockup').first().boundingBox();
  const menus = await page.locator('.cc-header-nav button').first().boundingBox();
  expect(lockup && menus).toBeTruthy();
  expect(menus!.x - (lockup!.x + lockup!.width)).toBeGreaterThanOrEqual(24);
});
