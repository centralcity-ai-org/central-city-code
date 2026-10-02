import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/*
 * Elric on/off in a room is one switch in the Members panel (one click): on = member, off =
 * removed (and it can be switched on again), plus "Manage Elric" in the room menu, which links to
 * /elric. Nothing is mocked: the fake-Google e2e server (e2e/google-server.ts,
 * CITY_ELRIC_MOCK=1) gives a verified adult, like e2e/elric-host-add.spec.ts.
 */
const port = Number(process.env.E2E_GOOGLE_PORT);
const fakePort = Number(process.env.E2E_GOOGLE_FAKE_PORT);
const base = `http://127.0.0.1:${port}`;
const headers = { 'x-city-request': '1' };

test('the host switches Elric on and off in a room; the menu links to /elric', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status')).toHaveText('Google account linked.');
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The host's room, hosted by one of their agents; the host never joins as a person.
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;

  const isMember = async () => {
    const members = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await members.json()).members as Array<{
      auto_reply?: { provider: string } | null;
    }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members, / }).click();
  const panel = page.getByRole('complementary', { name: 'Members' });
  const toggle = panel.getByRole('switch', { name: 'Elric in this room' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('Elric in this roomOff');
  const box = await toggle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);

  // On: one click (the date of birth is already known).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await expect(toggle).toBeEnabled();

  // Off from the keyboard: Space toggles it; Elric is removed.
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
  await expect(toggle).toBeEnabled();

  // On again: removing Elric never blocks adding it back.
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);

  await expect(toggle).toHaveText('Elric in this roomOn');

  // Fast presses while a change runs are not lost: off then on again ends on, and Elric is in.
  await toggle.click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).not.toHaveAttribute('aria-busy', 'true');
  await expect.poll(isMember).toBe(true);

  // The menu has no Add/Remove items, only the link to the console.
  await page.getByRole('button', { name: 'More room actions' }).click();
  const menu = page.getByRole('menu', { name: 'More room actions' });
  await expect(menu.getByRole('menuitem', { name: 'Add Elric' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Manage Elric' }).click();
  await expect(page).toHaveURL(`${base}/elric`);
});

test('a failed switch rolls back and shows a toast', async ({ page }) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Host ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status')).toHaveText('Google account linked.');
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // The host's room, hosted by one of their agents; the host never joins as a person.
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Host desk', capability: 'research', mode: 'hosted' },
  });
  expect(desk.status()).toBe(201);
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Host room',
      idempotency_key: randomUUID(),
    },
  });
  expect(room.status()).toBe(201);
  const roomId = (await room.json()).room.id as string;

  await page.goto(`${base}/rooms/${roomId}`);
  await page.getByRole('button', { name: /^Members, / }).click();
  const toggle = page
    .getByRole('complementary', { name: 'Members' })
    .getByRole('switch', { name: 'Elric in this room' });
  await page.route('**/api/rooms/*/join', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"x"}' }),
  );
  await toggle.click();
  await expect(page.getByRole('alert')).toContainText('Elric couldn’t join this room. Try again.');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('the host has the same switch in the room header, next to Members; it fits at 390 px', async ({
  page,
}) => {
  const subject = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:${fakePort}/authorize${new URL(route.request().url()).search}&e2e_subject=${subject}`,
      },
    }),
  );
  const created = await page.request.post(`${base}/api/auth/register`, {
    headers,
    data: { name: `Head ${randomUUID().slice(0, 8)}`, password: 'Local-test-only-passphrase-2026' },
  });
  expect(created.status()).toBe(201);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status')).toHaveText('Google account linked.');
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  const desk = await page.request.post(`${base}/api/agents`, {
    headers,
    data: { name: 'Head desk', capability: 'research', mode: 'hosted' },
  });
  const room = await page.request.post(`${base}/api/rooms`, {
    headers,
    data: {
      agent_id: (await desk.json()).agent.id,
      name: 'Head room',
      idempotency_key: randomUUID(),
    },
  });
  const roomId = (await room.json()).room.id as string;
  const isMember = async () => {
    const res = await page.request.get(`${base}/api/rooms/${roomId}/members`, { headers });
    const list = (await res.json()).members as Array<{ auto_reply?: { provider: string } | null }>;
    return list.some((member) => member.auto_reply?.provider === 'elric');
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/rooms/${roomId}`);
  const head = page.locator('.rm-room-head');
  const toggle = head.getByRole('switch', { name: 'Elric' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('ElricOff');
  // It sits in the header row without pushing anything off screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(isMember).toBe(true);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect.poll(isMember).toBe(false);
});
