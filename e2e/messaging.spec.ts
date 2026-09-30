import { test, expect, type Page } from '@playwright/test';

const password = 'Local-test-only-passphrase-2026';
const protectedJson = { 'X-City-Request': '1' };

/** Registers its own isolated workspace (the e2e server raises the registration limit). */
async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers: protectedJson,
    data: { name: 'Browser-Messaging', password },
  });
  expect(created.status()).toBe(201);
  const demo = await page.request.post('/api/demo/start', { headers: protectedJson, data: {} });
  expect(demo.status()).toBe(200);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();
}

test('owner sends as agent A to agent B and sees it in B’s inbox, then acknowledges it', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await signIn(page);
  await expect
    .poll(
      async () =>
        ((await (await page.request.get('/api/snapshot')).json()) as any).connections.length,
    )
    .toBe(2);

  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Messages.' })).toBeVisible();
  await page.getByRole('button', { name: 'Write the first message', exact: true }).click();
  const composer = page.getByRole('form', { name: 'New conversation' });
  await composer.getByLabel('Send as').selectOption({ label: 'Atlas → Relay' });
  const untrusted = 'Sync at 10:00?\n<img src=x onerror="window.__pwned=true">';
  await composer.getByLabel('Message text').fill(untrusted);
  await composer.getByRole('button', { name: 'Send message', exact: true }).click();

  const thread = page.getByRole('list', { name: 'Thread messages' });
  await expect(thread.getByTestId('message')).toHaveCount(1);
  await expect(thread).toContainText('Sync at 10:00?');
  await expect(thread).toContainText('<img src=x onerror="window.__pwned=true">');
  await expect(page.getByRole('navigation', { name: 'Conversations' })).toContainText(
    'Atlas ⇄ Relay',
  );
  // The recipient's unread count shows in the navigation and the inbox strip.
  await expect(page.getByLabel('1 unread messages')).toBeVisible({ timeout: 15_000 });

  await page
    .getByRole('button', { name: /^Relay/ })
    .first()
    .click();
  const inbox = page.getByRole('region', { name: 'Relay inbox' });
  await expect(inbox.getByTestId('message')).toHaveCount(1);
  await expect(inbox).toContainText('Atlas');
  await expect(inbox).toContainText('Sync at 10:00?');
  await expect(inbox).toContainText('1 of 1 unread by Relay.');
  await inbox.getByRole('button', { name: 'Mark read as Relay', exact: true }).click();
  await expect(inbox).toContainText('Relay has read all 1.');

  // Relay may answer Atlas only along an authorized route; Relay → Sentinel exists.
  await inbox.getByRole('button', { name: 'Write as Relay', exact: true }).click();
  const reply = page.getByRole('form', { name: 'Send as Relay' });
  await expect(reply.getByLabel('Send as')).toContainText('Relay → Sentinel');
  await page.screenshot({ path: 'test-results/agent-inbox.png', fullPage: true });

  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
  expect(errors).toEqual([]);
});
