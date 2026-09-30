import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * "Join a room": the host shares a short code from the Invite sheet; a signed-in
 * person types it under Rooms → Join a room, lands in the room with an "Invited by" banner, posts
 * as a person, and sees how to bring their own AI. Tolerant input and one uniform error.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUpAt(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createAccount = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createAccount)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createAccount).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createAccount.click();
  await expect(createAccount).toHaveCount(0);
}

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `${label}-${crypto.randomUUID().slice(0, 6)}`;
  await page.goto('/#signin');
  await signUpAt(page, name);
  return { context, page, errors, name };
}

test('a person joins with the host’s short code and posts as a person', async ({ browser }) => {
  const host = await account(browser, 'Host');
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Tea room');
  await dialog.getByLabel("Your agent's name (it hosts the room)").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);
  await host.page.getByRole('button', { name: 'Invite' }).first().click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite your AI' });
  const code = (await sheet.locator('.rm-code').textContent())!.trim();
  expect(code).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  await expect(
    sheet.getByRole('checkbox', { name: 'People can join as themselves' }),
  ).toBeChecked();
  await sheet.getByRole('button', { name: 'Close' }).first().click();

  const guest = await account(browser, 'Guest');
  await guest.page.goto('/rooms');
  await guest.page.getByRole('button', { name: 'Join a room' }).first().click();
  const join = guest.page.getByRole('dialog', { name: 'Join a room' });
  // A wrong code: one uniform message, no hint whether it exists.
  await join.getByLabel('Invite link or code').fill('zzzz-zzzz');
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(join.getByRole('alert')).toHaveText(
    'This invite is invalid or has expired. Ask the host for a new one.',
  );
  // Tolerant input: lowercase with spaces around it.
  await join.getByLabel('Invite link or code').fill(`  ${code.toLowerCase()}  `);
  await join.getByLabel('Your name in the room').fill('Mia');
  await join.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.page.getByRole('heading', { name: 'Tea room', level: 1 })).toBeVisible();
  await expect(
    guest.page.getByRole('status').filter({ hasText: 'You joined as Mia.' }),
  ).toContainText('Invited by Host agent.');
  // Bringing their own AI: a plain line linking to Connect your AI, with no
  // tool names, JSON or keys.
  const banner = guest.page.getByRole('status').filter({ hasText: 'You joined as Mia.' });
  await expect(banner).toContainText(
    "Want to bring your AI too? Connect your AI, then paste the room's invite link into it.",
  );
  await expect(banner.getByRole('link', { name: 'Connect your AI' })).toHaveAttribute(
    'href',
    '/#connect',
  );
  // The link opens the console straight on Connect your AI.
  const connect = await guest.context.newPage();
  await connect.goto('/#connect');
  await expect(connect.getByRole('heading', { name: 'Which AI do you use?' })).toBeVisible();
  await expect(
    connect.getByRole('navigation', { name: 'Workspace' }).getByRole('button', {
      name: 'Connect your AI',
      exact: true,
    }),
  ).toHaveClass(/active/);
  await connect.close();
  const visible = await guest.page.locator('main, [role="main"], body').first().innerText();
  for (const jargon of [/idempotency/i, /city_join_room/, /"room_id"/, /\bUUID\b/i])
    expect(visible).not.toMatch(jargon);
  const shots = process.env.ADD_AI_SHOTS_DIR;
  if (shots)
    for (const colorScheme of ['light', 'dark'] as const)
      for (const [width, height] of [
        [1440, 900],
        [360, 780],
      ] as const) {
        const shot = await guest.context.newPage();
        await shot.setViewportSize({ width, height });
        await shot.addInitScript((theme) => localStorage.setItem('cc-theme', theme), colorScheme);
        await shot.goto(guest.page.url());
        await expect(shot.getByText('Want to bring your AI?')).toBeVisible();
        await shot.screenshot({ path: `${shots}/room-person-banner-${width}-${colorScheme}.png` });
        await shot.close();
      }

  const box = guest.page.getByLabel('Message', { exact: true });
  await box.fill('Hello, Mia here in person');
  await box.press('Enter');
  const mine = guest.page
    .getByTestId('room-message')
    .filter({ hasText: 'Hello, Mia here in person' });
  await expect(mine.locator('.rm-person')).toHaveText('person');

  // The host sees the person in the members list, labelled as a person.
  await host.page.getByRole('button', { name: /^Members, / }).click();
  const panel = host.page.getByRole('complementary', { name: 'Members' });
  await expect(
    panel.getByRole('list', { name: 'Current members' }).getByRole('listitem').filter({
      hasText: 'Mia',
    }),
  ).toContainText('person');

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
