import { test, expect, type Page } from '@playwright/test';
import { LINKS } from '../src/shell/links';

/*
 * The app shell (design system v8; src/shell/tokens.css and src/shell/shell.css): tokens, the
 * one font, the public header and footer, the signed-in header and the 404 page.
 */

/**
 * Waits until a public page has really rendered: its own main content and the footer are
 * visible, the boot screen is gone and the web font has loaded. Measuring earlier can catch
 * the boot screen (two text nodes), which is what made the contrast test flaky in CI.
 */
async function pageSettled(page: Page) {
  await expect(page.locator('.boot-screen')).toHaveCount(0);
  await expect(page.locator('main#main-content h1')).toBeVisible();
  await expect(page.getByRole('contentinfo')).toBeVisible();
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
}

/** Serves index.html for SPA paths the local server does not list yet (Vercel rewrites them). */
async function serveSpa(page: Page, pattern: RegExp) {
  await page.route(pattern, async (route) => {
    const response = await route.fetch({ url: new URL('/', route.request().url()).toString() });
    await route.fulfill({ response });
  });
}

/** Waits for running CSS transitions, so colours are measured at rest rather than mid-fade. */
async function settleTransitions(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined)),
    ),
  );
}

/** Every visible text node with its colour against the nearest opaque background (WCAG 2.x). */
async function lowContrast(page: Page, root = 'body') {
  await settleTransitions(page);
  return page.evaluate((root) => {
    const canvas = document.createElement('canvas').getContext('2d')!;
    const rgba = (color: string) => {
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = color;
      canvas.fillRect(0, 0, 1, 1);
      return [...canvas.getImageData(0, 0, 1, 1).data];
    };
    const luminance = ([r, g, b]: number[]) =>
      [r, g, b]
        .map((value) => value / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const background = (element: Element | null): number[] => {
      for (; element; element = element.parentElement) {
        const value = rgba(getComputedStyle(element).backgroundColor);
        if (value[3] > 200) return value;
      }
      return rgba(getComputedStyle(document.body).backgroundColor);
    };
    // Where a failing pair sits, so a report names the element, not just its text.
    const where = (element: Element) => {
      const parts: string[] = [];
      for (
        let node: Element | null = element;
        node && node !== document.body;
        node = node.parentElement
      ) {
        parts.unshift(
          node.tagName.toLowerCase() + [...node.classList].map((name) => `.${name}`).join(''),
        );
        if (parts.length === 3) break;
      }
      return parts.join(' > ');
    };
    const results: {
      text: string;
      where: string;
      colors: string;
      ratio: number;
      minimum: number;
    }[] = [];
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const element = node.parentElement!;
      const style = getComputedStyle(element);
      if (!node.textContent!.trim() || !element.checkVisibility({ opacityProperty: true }))
        continue;
      const [foreground, back] = [rgba(style.color), background(element)];
      const [a, b] = [luminance(foreground), luminance(back)];
      const large =
        parseFloat(style.fontSize) >= 24 ||
        (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
      results.push({
        text: node.textContent!.trim().slice(0, 40),
        where: where(element),
        colors: `rgb(${foreground.slice(0, 3)}) on rgb(${back.slice(0, 3)})`,
        ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100,
        // WCAG AA is 4.5 (3 for large text); require a 0.1 margin so rendering differences
        // between browsers and platforms cannot tip a pair under the line.
        minimum: large ? 3.1 : 4.6,
      });
    }
    return { count: results.length, low: results.filter((item) => item.ratio < item.minimum) };
  }, root);
}

const tokens = (page: Page) =>
  page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string) => style.getPropertyValue(name).trim();
    const hex = (v: string) => v.replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
    return {
      canvas: hex(read('--canvas')),
      text: hex(read('--text')),
      link: hex(read('--link')),
      mention: hex(read('--mention')),
      primaryHover: hex(read('--primary-hover')),
      radiusS: read('--radius-s'),
      radiusL: read('--radius-l'),
      target: read('--target'),
      pageMax: read('--page-max'),
      // Durations in ms, whatever unit the minifier writes (240ms or .24s).
      dur3: Math.round(parseFloat(read('--dur-3')) * (read('--dur-3').endsWith('ms') ? 1 : 1000)),
      body: getComputedStyle(document.body).backgroundColor,
    };
  });

test('tokens follow the spec in light and dark, and the theme attribute wins', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  expect(await tokens(page)).toEqual({
    canvas: '#ffffff',
    text: '#09090b',
    link: '#0066ff',
    mention: '#0066ff',
    primaryHover: '#0052cc',
    radiusS: '6px',
    radiusL: '12px',
    target: '44px',
    pageMax: '1200px',
    dur3: 200,
    body: 'rgb(255, 255, 255)',
  });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect(await tokens(page)).toMatchObject({
    canvas: '#09090b',
    text: '#fafafa',
    link: '#98b0ff',
    mention: '#98b0ff',
    primaryHover: '#3a6af7',
    body: 'rgb(9, 9, 11)',
  });
  // An explicit choice overrides the system preference both ways.
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  expect((await tokens(page)).canvas).toBe('#ffffff');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  expect((await tokens(page)).canvas).toBe('#09090b');
  // Reduced motion zeroes durations.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect((await tokens(page)).dur3).toBe(0);
});

test('one font file: Inter latin, hashed, preloaded, and no Space Grotesk', async ({ page }) => {
  const fonts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fonts.push(new URL(request.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const preload = page.locator('link[rel="preload"][as="font"]');
  await expect(preload).toHaveCount(1);
  // A content-hashed build URL, so it can be cached as immutable (DESIGN_SYSTEM §1.2).
  const href = (await preload.getAttribute('href'))!;
  expect(href).toMatch(/^\/assets\/inter-latin-wght-normal-[A-Za-z0-9_-]{6,}\.woff2$/);
  await expect(preload).toHaveAttribute('crossorigin', '');
  // The preloaded URL is the one the stylesheet uses: exactly one font request.
  expect([...new Set(fonts)]).toEqual([href]);
  expect(
    await page.evaluate(() => document.fonts.check('600 48px "Inter Variable"', 'Central')),
  ).toBe(true);
  const families = await page.evaluate(() =>
    [...document.querySelectorAll('h1, p, a, button')].map(
      (element) => getComputedStyle(element).fontFamily,
    ),
  );
  expect(families.every((family) => family.startsWith('"Inter Variable"'))).toBe(true);
  const css = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
      .join('\n'),
  );
  expect(css).not.toMatch(/Space Grotesk/i);
  // The sign-in and connect pages use the same single file.
  await page.goto('/#connect');
  await page.evaluate(() => document.fonts.ready);
  expect([...new Set(fonts)]).toEqual([href]);
});

test('public header: logo, nav, Sign in, one primary action and the theme toggle', async ({
  page,
}) => {
  await page.goto('/');
  const header = page.getByRole('banner');
  await expect(header.getByRole('link', { name: 'Central City home' })).toHaveAttribute(
    'href',
    '/',
  );
  const nav = header.getByRole('navigation', { name: 'Public' });
  await expect(nav.getByRole('link')).toHaveText(['Downtown', 'Docs']);
  // Balanced: logo and Downtown on the left, Sign in and Invite your AI on the right.
  const left = (await nav.boundingBox())!;
  const right = (await header.locator('.cc-header-actions').boundingBox())!;
  expect(left.x + left.width).toBeLessThan(right.x);
  await expect(header.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/docs');
  await expect(header.getByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
    'href',
    '/#signin',
  );
  const invite = header.getByRole('link', { name: 'Invite your AI' });
  await expect(invite).toHaveAttribute('href', '/invite');
  await expect(header.locator('.cc-header-invite')).toHaveCount(1);
  await expect(header.getByRole('button', { name: /Use (dark|light) theme/ })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeHidden();
  // Transparent at the top, surface with elevation once scrolled.
  const background = () =>
    page
      .locator('header.cc-header')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background()).toBe('rgba(0, 0, 0, 0)');
  await page.mouse.wheel(0, 400);
  await expect.poll(background).toBe('rgb(255, 255, 255)');
});

test('public header: Developers disclosure with GitHub and Protocol', async ({ page }) => {
  test.skip(!LINKS.code, 'The Developers section appears once the public code repository is live.');
  await page.goto('/');
  const header = page.getByRole('banner');
  const nav = header.getByRole('navigation', { name: 'Public' });
  const button = nav.getByRole('button', { name: 'Developers' });
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  const code = nav.getByRole('link', { name: /GitHub/ });
  await expect(code).toBeHidden();

  // Opens on click; the links are the public code (new tab, noopener), Docs and Protocol.
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  const panel = page.locator(`#${await button.getAttribute('aria-controls')}`);
  await expect(panel.getByRole('link')).toHaveText([/^GitHub/, 'Protocol']);
  await expect(code).toHaveAttribute('href', LINKS.code!);
  await expect(code).toHaveAttribute('target', '_blank');
  await expect(code).toHaveAttribute('rel', /noopener/);
  await expect(code).toHaveAccessibleName('GitHub (opens in a new tab)');
  await expect(panel.getByRole('link', { name: 'Protocol' })).toHaveAttribute(
    'href',
    '/downtown#district-protocol',
  );
  for (const link of await panel.getByRole('link').all())
    expect((await link.boundingBox())!.height, await link.innerText()).toBeGreaterThanOrEqual(44);

  // Keyboard: Tab reaches the first link, Escape closes and returns focus to the button.
  await page.keyboard.press('Tab');
  await expect(code).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(code).toBeHidden();
  await expect(button).toBeFocused();

  // Enter toggles it; a click outside closes it.
  await page.keyboard.press('Enter');
  await expect(code).toBeVisible();
  await page.mouse.click(700, 500);
  await expect(code).toBeHidden();

  // Choosing a same-site link closes it and navigates.
  await button.click();
  await panel.getByRole('link', { name: 'Protocol' }).click();
  await expect(page).toHaveURL(/\/downtown#district-protocol$/);
  await expect(code).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('public header at 360 px: short primary label, menu with nav, Sign in and theme', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  const header = page.getByRole('banner');
  const invite = header.getByRole('link', { name: 'Invite your AI' });
  expect(await invite.innerText()).toBe('Invite AI');
  await expect(header.getByRole('navigation', { name: 'Public' })).toBeHidden();
  const box = await page.locator('.cc-header-inner').boundingBox();
  expect(box!.height).toBeLessThanOrEqual(56);
  const menuButton = header.getByRole('button', { name: 'Open menu' });
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  await menuButton.click();
  const menu = header.getByRole('navigation', { name: 'Menu' });
  await expect(menu.getByRole('link')).toHaveText(
    LINKS.code
      ? ['Downtown', 'Docs', /^GitHub/, 'Protocol', 'Sign in']
      : ['Downtown', 'Docs', 'Sign in'],
  );
  const developer = menu.getByRole('group', { name: 'Developers' });
  if (LINKS.code)
    await expect(developer.getByRole('link', { name: /GitHub/ })).toHaveAttribute(
      'href',
      LINKS.code,
    );
  else await expect(developer).toHaveCount(0);
  await expect(menu.getByRole('link').first()).toBeFocused();
  await expect(header.getByRole('button', { name: /Use (dark|light) theme/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(header.getByRole('button', { name: 'Open menu' })).toBeFocused();
  // Choosing a link closes the menu.
  await header.getByRole('button', { name: 'Open menu' }).click();
  await menu.getByRole('link', { name: 'Downtown' }).click();
  await expect(menu).toHaveCount(0);
  await expect(page).toHaveURL(/\/downtown$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of await header.locator('a:visible, button:visible').all()) {
    const size = await control.boundingBox();
    expect(size!.height, await control.innerText()).toBeGreaterThanOrEqual(44);
  }
});

test('footer bottom row has 44 px targets; the font licence lives on Downtown', async ({
  page,
}) => {
  await serveSpa(page, /\/downtown\/?$/);
  await page.goto('/');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('link', { name: /font licen/i })).toHaveCount(0);
  const bottom = footer.locator('.cc-footer-bottom a');
  await expect(bottom).toHaveCount(4);
  for (const link of await bottom.all())
    expect((await link.boundingBox())!.height, await link.innerText()).toBeGreaterThanOrEqual(44);
  await page.goto('/downtown');
  const licence = page.getByRole('link', { name: 'SIL Open Font License' });
  await expect(licence).toHaveAttribute('href', '/licenses/inter-OFL.txt');
  expect((await page.request.get('/licenses/inter-OFL.txt')).status()).toBe(200);
});

test('landing hero is one centred column at 1440 px', async ({ page }) => {
  await page.goto('/');
  const hero = page.getByRole('region', { name: 'Every AI. One room.' });
  const box = (await hero.boundingBox())!;
  const centre = box.x + box.width / 2;
  expect(Math.abs(centre - 1440 / 2)).toBeLessThanOrEqual(2);
  // The actions row is centred too: equal space left and right of its buttons.
  const first = (await hero.locator('.hero-actions > *').first().boundingBox())!;
  const last = (await hero.locator('.hero-actions > *').last().boundingBox())!;
  const left = first.x - box.x;
  const right = box.x + box.width - (last.x + last.width);
  expect(left).toBeGreaterThan(24);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  await expect(hero).toHaveCSS('text-align', 'center');
});

test('unknown paths show the 404 page in the public shell', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await serveSpa(page, /\/no-such-page$/);
  await page.goto('/no-such-page');
  await expect(
    page.getByRole('heading', { level: 1, name: 'This page doesn’t exist.' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Page not found · Central City');
  await expect(page.getByText('The link may be old or mistyped.')).toBeVisible();
  // Paths the SPA serves are never a 404: room pages and the client routes.
  for (const path of ['/r/launch-plan', '/downtown', '/connect']) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
  }
  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
  await expect(page.locator('main .button.primary')).toHaveCount(1);
  for (const path of ['/r/launch-plan', '/connect']) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 }), path).not.toHaveText(
      'This page doesn’t exist.',
    );
  }
  await page.goto('/no-such-page');
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`public pages meet text contrast in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    // The site is light unless dark is chosen: store the choice so dark is really checked.
    await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    await serveSpa(page, /\/(downtown|no-such-page)\/?$/);
    for (const path of ['/', '/#signin', '/#connect', '/downtown', '/no-such-page']) {
      await page.goto(path);
      await pageSettled(page);
      const result = await lowContrast(page);
      expect(result.count, path).toBeGreaterThan(8);
      expect(result.low, path).toEqual([]);
    }
  });
}

test('signed-in header is the page title and status; theme and refresh live in the sidebar', async ({
  page,
}) => {
  const created = await page.request.post('/api/auth/register', {
    headers: { 'X-City-Request': '1' },
    data: { name: `Browser-Shell-${Date.now()}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto('/');
  const header = page.locator('header.cc-app-header');
  await expect(header.getByText('Overview', { exact: true })).toBeVisible();
  await expect(header.getByText(/^(Live|Polling) updates$/)).toBeVisible();
  // Nothing competes in the header (§2.1); the drawer toggle only appears under 980 px.
  await expect(header.getByRole('button')).toHaveCount(0);
  const sidebar = page.locator('aside.sidebar');
  await expect(sidebar.getByRole('button', { name: /Use (dark|light) theme/ })).toBeVisible();
  await expect(sidebar.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await expect(sidebar.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(sidebar).not.toContainText('Private development preview');
  expect((await header.boundingBox())!.height).toBe(64);
  // The title follows the view.
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click();
  await expect(header.getByText('Agents', { exact: true })).toBeVisible();
  // Contrast of the restyled header (the console body is restyled separately).
  const result = await lowContrast(page, 'header.cc-app-header');
  expect(result.count).toBeGreaterThan(1);
  expect(result.low).toEqual([]);

  await page.setViewportSize({ width: 360, height: 780 });
  await header.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeInViewport();
});

test('the landing page downloads no console code (route-level code splitting)', async ({
  page,
}) => {
  const scripts: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') scripts.push(new URL(request.url()).pathname);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const names = scripts.map((path) =>
    path.replace(/^\/assets\//, '').replace(/-[A-Za-z0-9_-]{8}\.js$/, ''),
  );
  expect(names).toContain('vendor');
  expect(names).toContain('Landing');
  for (const console of ['App', 'Connect', 'Downtown', 'components'])
    expect(names, console).not.toContain(console);
  // Signing in then loads the console chunk on demand.
  await page.getByRole('banner').getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
  expect(scripts.some((path) => /\/assets\/App-[^/]+\.js$/.test(path))).toBe(true);
});

test('a chunk that fails to load reloads up to three times, then shows the error state', async ({
  page,
}) => {
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page.route(/\/assets\/Landing-[^/]+\.js$/, (route) => route.abort());
  await page.goto('/');
  const alert = page.getByRole('alert');
  // The reloads wait 0, 1 and 3 s (src/shell/ErrorBoundary.tsx, RELOAD_DELAYS_MS).
  await expect(alert.getByRole('heading', { name: 'Something went wrong.' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(alert.getByText('We couldn’t load this page. Try again in a moment.')).toBeVisible();
  expect(navigations).toBe(4); // the first load plus three automatic reloads
  await alert.getByText('Details').click();
  await expect(alert.getByText('chunk_load_failed')).toBeVisible();
  // Once the chunk is reachable again, "Try again" recovers.
  await page.unroute(/\/assets\/Landing-[^/]+\.js$/);
  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Every AI. One room.' })).toBeVisible();
});

test('on the landing page the header button steps back while the hero button is visible', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await page.goto('/');
  const header = page.getByRole('banner').getByRole('link', { name: 'Invite your AI' });
  await expect(header).toHaveClass(/\bsecondary\b/);
  // v8 intentionally has a filled hero 'Sign up' and a filled CTA 'Invite your AI' (the v8 landing).
  // Allow up to two filled primary buttons on the landing page while the header button steps back.
  const filledButtons = await page.locator('.button.primary:visible').count();
  expect(filledButtons).toBeGreaterThanOrEqual(1);
  expect(filledButtons).toBeLessThanOrEqual(2);
  await page.locator('#how').scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 2000);
  await expect(header).toHaveClass(/\bprimary\b/);
  // Other pages have no hero button, so the header's is primary.
  await page.goto('/#connect');
  await expect(page.getByRole('banner').getByRole('link', { name: 'Invite your AI' })).toHaveClass(
    /\bprimary\b/,
  );
});
