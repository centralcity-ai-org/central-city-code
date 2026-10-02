import {
  test,
  expect as baseExpect,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * Self notifications mute: any room member (host or joined) can mute or
 * unmute notifications for that room from the "…" menu.
 *
 * Muting sets notifications_muted: true in GET /api/rooms and turns the menu item to
 * "Unmute this room". Unmuting returns it to false and "Mute this room".
 */
const expect = baseExpect.configure({ timeout: 15_000 });
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'X-City-Request': '1' };

/**
 * The test server allows each address 600 API requests a minute across the whole suite, so setup
 * calls wait out a 429 (Retry-After) instead of failing on earlier specs' traffic, and every
 * context is closed after its test so no page keeps polling into later specs.
 */
async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
/** The context request API, with each call waiting out a 429. */
function patientRequest(context: BrowserContext) {
  const request = context.request;
  return {
    get: (url: string, options?: Parameters<typeof request.get>[1]) =>
      patient(() => request.get(url, options)),
    post: (url: string, options?: Parameters<typeof request.post>[1]) =>
      patient(() => request.post(url, options)),
  };
}
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

type Account = Awaited<ReturnType<typeof account>>;
async function account(
  browser: Browser,
  label: string,
  viewport?: { width: number; height: number },
) {
  const context = await browser.newContext(viewport ? { viewport } : {});
  opened.push(context);
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await patientRequest(context).post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return { name, context, request: patientRequest(context), page, errors };
}

async function agent(owner: Account, name: string) {
  const response = await owner.request.post('/api/agents', {
    headers,
    data: { name, capability: 'research', mode: 'hosted' },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).agent.id as string;
}

async function hostRoom(owner: Account, name: string) {
  const hostAgent = await agent(owner, 'Host agent');
  const response = await owner.request.post('/api/rooms', {
    headers,
    data: { agent_id: hostAgent, name, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(201);
  const room = (await response.json()).room as { id: string; slug: string };
  const minted = await owner.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  expect(minted.status()).toBe(200);
  const link = (await minted.json()).link as string;
  return { ...room, link, token: new URL(link).hash.slice(1) };
}

async function join(owner: Account, room: { id: string; token: string }, agentName: string) {
  const response = await owner.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token: room.token, create: { name: agentName }, idempotency_key: crypto.randomUUID() },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).agent_id as string;
}

test('host: mute notifications turns the menu to Unmute and sets notifications_muted true in GET /api/rooms', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Protocol discussion');
  await host.page.goto(`/rooms/${room.id}`);

  // Initially notifications are not muted.
  const initialRooms = await (await host.request.get('/api/rooms', { headers })).json();
  const initialRoom = (
    initialRooms.rooms as Array<{ id: string; notifications_muted?: boolean }>
  ).find((r) => r.id === room.id);
  expect(initialRoom?.notifications_muted).toBe(false);

  // Open "…" menu.
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  const muteItem = host.page.getByRole('menuitem', { name: 'Mute this room', exact: true });
  await expect(muteItem).toBeVisible();

  // Click Mute this room.
  await muteItem.click();

  // GET /api/rooms now reflects notifications_muted: true.
  await expect
    .poll(async () => {
      const res = await (await host.request.get('/api/rooms', { headers })).json();
      const current = (res.rooms as Array<{ id: string; notifications_muted?: boolean }>).find(
        (r) => r.id === room.id,
      );
      return current?.notifications_muted;
    })
    .toBe(true);

  // Open "…" menu again: item now says "Unmute this room".
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  const unmuteItem = host.page.getByRole('menuitem', { name: 'Unmute this room', exact: true });
  await expect(unmuteItem).toBeVisible();

  // Click Unmute this room.
  await unmuteItem.click();

  // GET /api/rooms now reflects notifications_muted: false.
  await expect
    .poll(async () => {
      const res = await (await host.request.get('/api/rooms', { headers })).json();
      const current = (res.rooms as Array<{ id: string; notifications_muted?: boolean }>).find(
        (r) => r.id === room.id,
      );
      return current?.notifications_muted;
    })
    .toBe(false);

  // Menu flips back to "Mute this room".
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  await expect(
    host.page.getByRole('menuitem', { name: 'Mute this room', exact: true }),
  ).toBeVisible();

  expect(host.errors).toEqual([]);
});

test('member: mutes and unmutes notifications independently from the host', async ({ browser }) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Shared workspace');
  const member = await account(browser, 'Member');
  await join(member, room, 'Collab agent');

  await member.page.goto(`/rooms/${room.id}`);

  // Member opens "…" menu and mutes.
  await member.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  const muteItem = member.page.getByRole('menuitem', { name: 'Mute this room', exact: true });
  await expect(muteItem).toBeVisible();
  await muteItem.click();

  // Member sees notifications_muted: true in their rooms list.
  await expect
    .poll(async () => {
      const res = await (await member.request.get('/api/rooms', { headers })).json();
      const current = (res.rooms as Array<{ id: string; notifications_muted?: boolean }>).find(
        (r) => r.id === room.id,
      );
      return current?.notifications_muted;
    })
    .toBe(true);

  // Host remains unmuted.
  const hostRooms = await (await host.request.get('/api/rooms', { headers })).json();
  const hostRoomEntry = (
    hostRooms.rooms as Array<{ id: string; notifications_muted?: boolean }>
  ).find((r) => r.id === room.id);
  expect(hostRoomEntry?.notifications_muted).toBe(false);

  // Member unmutes.
  await member.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  const unmuteItem = member.page.getByRole('menuitem', { name: 'Unmute this room', exact: true });
  await expect(unmuteItem).toBeVisible();
  await unmuteItem.click();

  // Member sees notifications_muted: false again.
  await expect
    .poll(async () => {
      const res = await (await member.request.get('/api/rooms', { headers })).json();
      const current = (res.rooms as Array<{ id: string; notifications_muted?: boolean }>).find(
        (r) => r.id === room.id,
      );
      return current?.notifications_muted;
    })
    .toBe(false);

  expect(member.errors).toEqual([]);
});

test('failure: shows an error banner when changing notifications fails and reverts state', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Error test room');
  await host.page.goto(`/rooms/${room.id}`);

  // Intercept the notifications endpoint to simulate a server error.
  await host.page.route('**/api/rooms/*/notifications', async (route) => {
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'internal_error', message: 'Failed to update' } }),
    });
  });

  // Open "…" menu.
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  const muteItem = host.page.getByRole('menuitem', { name: 'Mute this room', exact: true });
  await expect(muteItem).toBeVisible();
  await muteItem.click();

  // Expect plain error message to appear with role="alert".
  const alert = host.page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Couldn't change notifications. Try again.");

  // Menu item should revert to "Mute this room".
  await host.page
    .locator('.rm-room-head')
    .getByRole('button', { name: 'More room actions' })
    .click();
  await expect(
    host.page.getByRole('menuitem', { name: 'Mute this room', exact: true }),
  ).toBeVisible();
});
