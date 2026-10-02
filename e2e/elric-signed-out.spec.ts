import { test, expect, type Page, type Route } from '@playwright/test';

/*
 * /elric for a signed-out visitor (W2, the approved mockup v2) and the inline first step for a
 * signed-in person without Elric. The e2e server runs without CITY_ELRIC, so /api/elric* is
 * served by page.route with the server's shapes: GET /api/elric answers 401 to a visitor when
 * Elric is on (404 when it is off). Sign-in itself is real.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const CHAT = 'c4a1e2f0-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** Elric on; `under18` makes the age check refuse. Returns what the page asked for. */
async function mockElricOn(page: Page, opts: { under18?: boolean } = {}) {
  const state = { signedIn: false, created: false, ages: [] as unknown[] };
  page.on('response', (response) => {
    if (/\/api\/auth\/(register|login)$/.test(response.url()) && response.ok())
      state.signedIn = true;
  });
  await page.route('**/api/auth/google', (route) => json(route, { enabled: true, linked: null }));
  await page.route('**/api/elric', (route) => {
    if (!state.signedIn) return json(route, { error: 'Sign in to continue.' }, 401);
    if (route.request().method() === 'POST') {
      state.created = true;
      return json(route, { agent_id: 'elric-agent', created: true }, 201);
    }
    return json(route, {
      agent_id: state.created ? 'elric-agent' : null,
      status: state.created ? 'active' : null,
      eligible: false,
      usage: {
        used: { short: 0, summary: 0, tool: 0 },
        allowance: { short: 20, summary: 4, tool: 5 },
        resets_at: '2026-10-02T00:00:00.000Z',
      },
    });
  });
  await page.route('**/api/elric/age', (route) => {
    state.ages.push(route.request().postDataJSON());
    return opts.under18
      ? json(route, { error: 'Elric is available from age 18.', code: 'elric_age_under_18' }, 403)
      : json(route, { age_check: 'over_18' });
  });
  await page.route('**/api/elric/chat*', (route) =>
    state.created
      ? json(route, {
          room_id: CHAT,
          slug: 'elric-chat',
          person_member_id: 'p-1',
          status: 'active',
          latest_seq: 0,
          waking: false,
          pending_count: 0,
        })
      : json(route, { error: 'You have no Elric.', code: 'elric_not_found' }, 404),
  );
  await page.route(`**/api/rooms/${CHAT}/messages*`, (route) =>
    json(route, {
      room: { id: CHAT, slug: 'elric-chat', name: 'Elric', role: 'host', latest_seq: 0 },
      messages: [],
      latest_seq: 0,
      visible_from_seq: 0,
      next_since: 0,
      has_more: false,
    }),
  );
  await page.route('**/api/elric/pending', (route) => json(route, { pending: [] }));
  return state;
}

test('signed out: the chat screen, four suggestions, and typing opens the sign-in sheet', async ({
  page,
}) => {
  await mockElricOn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.locator('.elx-out-card')).toHaveCount(4);
  const header = page.locator('.elx-out-header');
  await expect(header.getByRole('button', { name: 'Log in' })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Sign up for free' })).toBeVisible();
  await expect(header.locator('.elx-tag')).toHaveText('AI');

  await page.getByLabel('Message Elric').pressSequentially('Hi');
  const sheet = page.getByRole('dialog', { name: 'Log in or sign up to talk to Elric' });
  await expect(sheet).toBeVisible();
  // Continue with Google first, then Log in, then Sign up for free.
  await expect(sheet.locator('.elx-auth-actions button')).toHaveText([
    'Continue with Google',
    'Log in',
    'Sign up for free',
  ]);
  await expect(sheet.getByRole('button', { name: 'Continue with Google' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // A suggestion opens it too; nothing about models anywhere.
  await page.locator('.elx-out-card').first().click();
  await expect(sheet).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/gemma|haiku|claude|anthropic|gpt-/i);
});

test('signed out with Elric off on the server: not found', async ({ page }) => {
  await page.goto('/elric');
  await expect(page.getByText('This page doesn’t exist.')).toBeVisible();
});

test('sign up from the sheet, then the date of birth once, then the chat', async ({ page }) => {
  const state = await mockElricOn(page);
  await page.goto('/elric');
  await page.locator('.elx-out-card').nth(1).click();
  await page
    .getByRole('dialog', { name: 'Log in or sign up to talk to Elric' })
    .getByRole('button', { name: 'Sign up for free' })
    .click();
  await expect(page.getByRole('heading', { name: 'Create your account.' })).toBeVisible();
  await page.getByLabel('Account name').fill(`Elric-new-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Back on /elric, signed in: one inline step for the date of birth.
  await expect(page).toHaveURL(/\/elric$/);
  await expect(page.getByText('Elric is for adults. Enter your date of birth once.')).toBeVisible();
  await page.getByLabel('Date of birth').fill('1990-05-17');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Message Elric')).toBeVisible();
  expect(state.ages).toEqual([{ date_of_birth: '1990-05-17' }]);
  expect(state.created).toBe(true);
});

test('under 18: the server refuses and the page says so plainly', async ({ page }) => {
  await mockElricOn(page, { under18: true });
  await page.goto('/elric');
  await page.locator('.elx-out-header').getByRole('button', { name: 'Sign up for free' }).click();
  await page.getByLabel('Account name').fill(`Elric-young-${crypto.randomUUID().slice(0, 8)}`);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByLabel('Date of birth').fill('2012-05-17');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Elric is for adults' })).toBeVisible();
  await expect(page.getByText('Elric is available from age 18.')).toBeVisible();
  await expect(page.getByLabel('Date of birth')).toHaveCount(0);
});

test('390 px: one row header, a bottom sheet, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElricOn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  expect((await page.locator('.elx-out-header').boundingBox())!.height).toBeLessThanOrEqual(57);
  await page.locator('.elx-out-card').first().click();
  const sheet = page.getByRole('dialog', { name: 'Log in or sign up to talk to Elric' });
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(Math.round(box.y + box.height)).toBe(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('Continue with Google asks to come back to /elric', async ({ page }) => {
  await mockElricOn(page);
  const starts: unknown[] = [];
  await page.route('**/api/auth/google/start', (route) => {
    starts.push(route.request().postDataJSON());
    return json(route, { url: '/elric?google=test' });
  });
  await page.goto('/elric');
  await page.locator('.elx-out-card').first().click();
  await page
    .getByRole('dialog', { name: 'Log in or sign up to talk to Elric' })
    .getByRole('button', { name: 'Continue with Google' })
    .click();
  await expect.poll(() => starts).toEqual([{ intent: 'signin', next: '/elric' }]);
});
