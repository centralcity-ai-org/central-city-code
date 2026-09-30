import { test, expect as baseExpect, type Browser, type Page } from '@playwright/test';

/*
 * First-run audit fixes:
 * P1 a member leaves a room (confirm, then the room is gone from its list); the host is told it
 * closes the room instead. P2 the owner label reads "another person's agent". P3 at 360 px the
 * Invite sheet puts Copy invite right under the link, above the how-to paragraphs.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';

async function signUpAt(page: Page, name: string) {
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createWorkspace).toBeVisible();
  await page.getByLabel(/^(Account|Operator) name$/).fill(name);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await createWorkspace.click();
  await expect(createWorkspace).toHaveCount(0);
}

async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, errors, name: `${label}-${crypto.randomUUID().slice(0, 8)}` };
}

test('a member leaves a room; the host closes instead; labels and the invite sheet read right', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  await host.page.goto('/#signin');
  await signUpAt(host.page, host.name);
  await host.page.goto('/rooms');
  await host.page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = host.page.getByRole('dialog', { name: 'New room' });
  await dialog.getByLabel('Room name').fill('Leave plan');
  await dialog.getByLabel("Your agent's name (it hosts the room)").fill('Host agent');
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(host.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  // P3: at 360 px, Copy invite sits right under the link, above the how-to paragraphs, and on
  // the first screen.
  await host.page.setViewportSize({ width: 360, height: 780 });
  await host.page.getByRole('button', { name: 'Invite' }).first().click();
  const sheet = host.page.getByRole('dialog', { name: 'Invite your AI' });
  const field = sheet.getByLabel('Invite link');
  await expect(field).toHaveValue(/\/j\//);
  const copy = sheet.getByRole('button', { name: 'Copy invite' });
  // The first how-to paragraph (its wording belongs to the copy owner, not this test).
  const howTo = sheet.locator('.rm-instruction').first();
  const [fieldBox, copyBox, howToBox] = await Promise.all([
    field.boundingBox(),
    copy.boundingBox(),
    howTo.boundingBox(),
  ]);
  expect(copyBox!.y).toBeGreaterThan(fieldBox!.y);
  expect(copyBox!.y).toBeLessThan(howToBox!.y);
  expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(780);
  const link = await field.inputValue();
  await sheet.getByRole('button', { name: 'Close' }).first().click();

  const guest = await account(browser, 'Guest');
  await guest.page.goto(link);
  await guest.page.getByRole('link', { name: 'Join room' }).click();
  await guest.page.getByRole('button', { name: 'Sign in to join' }).click();
  await signUpAt(guest.page, guest.name);
  await guest.page.getByRole('button', { name: 'Join room' }).click();
  await expect(guest.page).toHaveURL(/\/rooms\/[A-Za-z0-9_-]+$/);

  // P2: the host's agent is "another person's agent · host".
  await guest.page.getByRole('button', { name: /^Members, / }).click();
  const panel = guest.page.getByRole('complementary', { name: 'Members' });
  await expect(panel.getByRole('listitem').filter({ hasText: 'Host agent' })).toContainText(
    "another person's agent · host",
  );

  // P1: Leave, with a confirm; Cancel keeps the membership.
  await panel.getByRole('button', { name: 'Leave room' }).click();
  await expect(panel.getByText(/stops reading and posting here/)).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await panel.getByRole('button', { name: 'Leave room' }).click();
  await panel.getByRole('button', { name: 'Confirm leave' }).click();
  await expect(guest.page).toHaveURL(/\/rooms$/);
  await expect(guest.page.getByRole('link', { name: /Leave plan/ })).toHaveCount(0);

  // The host sees one member left and cannot leave itself: it is pointed at Close room.
  await host.page.getByRole('button', { name: /^Members, / }).click();
  const hostPanel = host.page.getByRole('complementary', { name: 'Members' });
  await expect(
    hostPanel.getByRole('list', { name: 'Current members' }).getByRole('listitem'),
  ).toHaveCount(1);
  await expect(hostPanel.getByText("You host this room, so you can't leave it.")).toBeVisible();
  await expect(hostPanel.getByRole('button', { name: 'Leave room' })).toHaveCount(0);
  await expect(hostPanel.getByRole('button', { name: 'Close room' })).toBeVisible();

  // The guest left on its own: the host still sees it under "Recently left" and can remove it
  // (a ban), after which it disappears from that list.
  await expect(hostPanel.getByText('Recently left')).toBeVisible();
  await hostPanel.getByRole('button', { name: /^Remove .* \(can't rejoin\)$/ }).click();
  await hostPanel.getByRole('button', { name: 'Confirm remove' }).click();
  await expect(hostPanel.getByText('Recently left')).toHaveCount(0);

  expect(host.errors).toEqual([]);
  expect(guest.errors).toEqual([]);
  await host.context.close();
  await guest.context.close();
});
