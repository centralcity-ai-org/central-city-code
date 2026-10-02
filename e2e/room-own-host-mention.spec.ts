import { test, expect, type Browser, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * "@<your own host>" is not a mention. The owner of the room's host agent doesn't get that host
 * in the @ picker, and their "@Host" isn't highlighted (the server records no mention, so nothing
 * is woken). A second member still sees the host in the picker and mentions it normally.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, name: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `${name}-${randomUUID().slice(0, 6)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return page;
}

async function personId(page: Page, roomId: string) {
  const res = await page.request.get(`/api/rooms/${roomId}/members`, { headers });
  const members = (await res.json()).members as Array<{ id: string; own: boolean; kind?: string }>;
  return members.find((m) => m.own && m.kind === 'person')!.id;
}

test('your own host is not in your @ picker or highlighted; a second member mentions it', async ({
  browser,
}) => {
  // The host: an agent "Hostbot" hosts the room; its owner is also in the room as a person.
  const host = await account(browser, 'host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Hostbot', capability: 'research', mode: 'hosted' },
  });
  expect(agent.ok()).toBe(true);
  const room = await host.request.post('/api/rooms', {
    headers,
    data: {
      agent_id: (await agent.json()).agent.id,
      name: 'Mentions',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;
  const link = await host.request.post('/api/links', {
    headers,
    data: { target: 'room', room_id: roomId },
  });
  const code = (await link.json()).code as string;
  const join = (page: Page, name: string) =>
    page.request.post('/api/rooms/join', {
      headers,
      data: { code, name, idempotency_key: randomUUID() },
    });
  expect((await join(host, 'Hana')).ok()).toBe(true);

  // A second member, Bea, joins as a person.
  const bea = await account(browser, 'bea');
  expect((await join(bea, 'Bea')).ok()).toBe(true);

  // Both write "@Hostbot …" as themselves.
  const say = async (page: Page, text: string) =>
    expect(
      (
        await page.request.post(`/api/rooms/${roomId}/messages`, {
          headers,
          data: { text, idempotency_key: randomUUID(), agent_id: await personId(page, roomId) },
        })
      ).status(),
    ).toBe(201);
  await say(host, 'Reminder to myself: @Hostbot summarize later');
  await say(bea, 'Question for @Hostbot please');

  // The host's view: no Hostbot in the picker; Bea is offered.
  await host.goto(`/rooms/${roomId}`);
  const box = host.getByRole('textbox', { name: 'Message' });
  await box.click();
  await box.pressSequentially('@');
  const picker = host.getByRole('listbox', { name: 'Mention a member' });
  await expect(picker.getByRole('option', { name: /Bea/ })).toBeVisible();
  await expect(picker.getByRole('option', { name: /Hostbot/ })).toHaveCount(0);
  await box.pressSequentially('Host');
  await expect(picker).toHaveCount(0);
  // Its own "@Hostbot" is plain text; Bea's "@Hostbot" is a mention.
  const messages = host.getByTestId('room-message');
  await expect(
    messages.filter({ hasText: 'Reminder to myself' }).locator('.rm-mention'),
  ).toHaveCount(0);
  await expect(messages.filter({ hasText: 'Question for' }).locator('.rm-mention')).toHaveText(
    '@Hostbot',
  );

  // Bea's view: Hostbot is offered and her mention is highlighted.
  await bea.goto(`/rooms/${roomId}`);
  const beaBox = bea.getByRole('textbox', { name: 'Message' });
  await beaBox.click();
  await beaBox.pressSequentially('@Host');
  await expect(
    bea.getByRole('listbox', { name: 'Mention a member' }).getByRole('option', { name: /Hostbot/ }),
  ).toBeVisible();
  await expect(
    bea.getByTestId('room-message').filter({ hasText: 'Question for' }).locator('.rm-mention'),
  ).toHaveText('@Hostbot');
  // The host's note to itself isn't a mention for Bea either (the server recorded none).
  await expect(
    bea
      .getByTestId('room-message')
      .filter({ hasText: 'Reminder to myself' })
      .locator('.rm-mention'),
  ).toHaveCount(0);
});
