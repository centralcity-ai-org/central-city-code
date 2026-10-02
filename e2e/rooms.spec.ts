import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  test,
  expect as baseExpect,
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  type Page,
} from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createServer, type ViteDevServer } from 'vite';

/**
 * Rooms experience against the live server (DESIGN_SYSTEM §2.4–2.7, §3.3). Until the app shell
 * mounts RoomsApp, a Vite harness serves /r/:slug, /rooms, /rooms/:id and /signin with
 * the production RoomsApp and proxies /api to the Playwright web server. Cases carried over from
 * an earlier rooms test suite (join, revoked invite, host controls, lost rotation response) are marked.
 */
const expect = baseExpect.configure({ timeout: 15_000 });
/**
 * This spec runs its own API server (same command and settings as the Playwright web server), so
 * the per-address request budget (600 a minute) is not shared with the rest of the suite.
 */
let API = '';
let apiServer: ChildProcess | undefined;
async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createNetServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => done(port));
    });
  });
}
async function startApi() {
  const port = await freePort();
  apiServer = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...process.env,
      PORT: String(port),
      CITY_DATA_DIR: 'memory://',
      CITY_LIMIT_REGISTRATIONS_PER_WINDOW: '1000',
    },
    stdio: 'ignore',
  });
  API = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${API}/api/session`)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('The rooms API server did not start.');
}
// The harness origin; a free port unless CITY_ROOMS_TEST_PORT is set (assigned in beforeAll).
let PORT = Number(process.env.CITY_ROOMS_TEST_PORT || 0);
let APP = '';
const headers = { 'X-City-Request': '1' };
const PASSWORD = 'Local-test-only-passphrase-2026';

let harness: ViteDevServer;
test.beforeAll(async () => {
  test.setTimeout(90_000);
  await startApi();
  PORT ||= await freePort();
  APP = `http://127.0.0.1:${PORT}`;
  const html = readFileSync(resolve('src/rooms/harness.html'), 'utf8');
  harness = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'error',
    appType: 'custom',
    plugins: [
      react(),
      {
        name: 'rooms-harness-routes',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            const path = (request.url ?? '/').split('?')[0]!;
            if (!/^\/(?:r\/[A-Za-z0-9_-]+|rooms(?:\/[A-Za-z0-9_-]+)?|signin)$/.test(path))
              return next();
            void server.transformIndexHtml(request.url ?? '/', html).then((page) => {
              response.setHeader('content-type', 'text/html');
              response.end(page);
            }, next);
          });
        },
      },
    ],
    server: {
      host: '127.0.0.1',
      port: PORT,
      strictPort: true,
      // Same-origin for the server's CSRF check: the proxy presents the API's host and origin.
      proxy: {
        '/api': {
          target: API,
          changeOrigin: true,
          configure: (proxy) =>
            proxy.on('proxyReq', (request) => {
              if (request.getHeader('origin')) request.setHeader('origin', API);
            }),
        },
      },
    },
  });
  await harness.listen();
});
test.afterAll(async () => {
  await harness?.close();
  apiServer?.kill();
});

/**
 * The test server limits each address to 600 API requests a minute across the whole suite, so
 * setup calls wait out a 429 (Retry-After) instead of failing a test for earlier specs' traffic.
 */
async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}

type Account = { name: string; context: BrowserContext; request: APIRequestContext };
/** Every context a test opens; closed after it, so no page keeps polling into later tests. */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});
async function account(browser: Browser, label: string): Promise<Account> {
  const context = await browser.newContext({ baseURL: APP });
  opened.push(context);
  const name = `${label} ${crypto.randomUUID().slice(0, 8)}`;
  const created = await patient(() =>
    context.request.post(`${API}/api/auth/register`, {
      headers,
      data: { name, password: PASSWORD },
    }),
  );
  expect(created.status()).toBe(201);
  return { name, context, request: context.request };
}
async function agent(owner: Account, name: string): Promise<string> {
  const response = await patient(() =>
    owner.request.post(`${API}/api/agents`, {
      headers,
      data: { name, capability: 'research', mode: 'hosted' },
    }),
  );
  expect(response.status()).toBe(201);
  return (await response.json()).agent.id;
}
async function hostRoom(owner: Account, name = 'Launch plan') {
  const hostAgent = await agent(owner, 'Host agent');
  const response = await patient(() =>
    owner.request.post(`${API}/api/rooms`, {
      headers,
      data: { agent_id: hostAgent, name, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(response.status()).toBe(201);
  const room = (await response.json()).room as { id: string; slug: string };
  // Minting a room link is a POST since #56 (GET never mutates).
  const minted = await patient(() =>
    owner.request.post(`${API}/api/rooms/${room.id}/link`, {
      headers,
      data: {},
    }),
  );
  expect(minted.status()).toBe(200);
  const link = (await minted.json()).link as string;
  const token = new URL(link).hash.slice(1);
  expect(token).toMatch(/^crr_/);
  return { ...room, hostAgent, token };
}
async function join(owner: Account, room: { id: string; token: string }, agentName: string) {
  const response = await patient(() =>
    owner.request.post(`${API}/api/rooms/${room.id}/join`, {
      headers,
      data: {
        token: room.token,
        create: { name: agentName },
        idempotency_key: crypto.randomUUID(),
      },
    }),
  );
  expect(response.status()).toBe(200);
  return (await response.json()).agent_id as string;
}
async function post(owner: Account, roomId: string, body: Record<string, unknown>) {
  const response = await patient(() =>
    owner.request.post(`${API}/api/rooms/${roomId}/messages`, {
      headers,
      data: { ...body, idempotency_key: crypto.randomUUID() },
    }),
  );
  expect(response.status()).toBe(201);
  return (await response.json()).message as { id: string };
}
/**
 * Clicks "Join room" and, if the suite-wide address limit answered 429 ("Too many…"), waits and
 * clicks again (the same idempotency key is replayed, so this never joins twice).
 */
async function joinByClick(page: Page) {
  const button = page.getByRole('button', { name: 'Join room' });
  for (let attempt = 0; attempt < 8; attempt++) {
    await button.click();
    const limited = page.getByRole('alert').filter({ hasText: /^Too many/ });
    const outcome = await Promise.race([
      page
        .getByRole('heading', { level: 1 })
        .filter({ hasNotText: 'Join the room' })
        .waitFor({ timeout: 20_000 })
        .then(
          () => 'done',
          () => 'timeout',
        ),
      limited.waitFor({ timeout: 20_000 }).then(
        () => 'limited',
        () => 'timeout',
      ),
    ]);
    if (outcome !== 'limited') return; // done, or let the caller's assertion report it
    await page.waitForTimeout(5_000);
  }
}
/** Polls run now (the room polls on visibilitychange) instead of after 5 s. */
const pollNow = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
const list = (page: Page) => page.getByRole('list', { name: 'Room messages' });
const message = (page: Page, text: string) => list(page).getByText(text, { exact: true });
/**
 * Whether the message whose text is `text` is fully inside the scroller. Found and measured in one
 * evaluate on the stable scroller: a Markdown message first renders as plain text and is then
 * swapped (Suspense), so a handle to the text element can be detached by the time it is measured.
 */
async function inView(page: Page, text: string) {
  return page.getByTestId('room-scroll').evaluate((view, wanted) => {
    const item = [...view.querySelectorAll<HTMLElement>('[data-testid="room-message"]')].find(
      (element) => element.querySelector('.rm-bubble')?.textContent?.trim() === wanted,
    );
    if (!item) return false;
    const box = item.querySelector('.rm-bubble')!.getBoundingClientRect();
    const frame = view.getBoundingClientRect();
    return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
  }, text);
}

test('join link: signed out → sign in → join; the code never appears in a URL, history or request (#31)', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  await guest.context.clearCookies(); // signed out in the browser
  const page = await guest.context.newPage();
  const seen: string[] = [];
  page.on('request', (request) => {
    seen.push(request.url(), request.headers()['referer'] ?? '');
  });
  const urls: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) urls.push(frame.url());
  });

  await page.goto(`/r/${room.slug}#${room.token}`);
  await expect(page.getByRole('button', { name: 'Sign in to join' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/r/${room.slug}`);
  expect(
    await page.evaluate(() => JSON.parse(sessionStorage.getItem('cc.pendingJoin') ?? '{}').slug),
  ).toBe(room.slug);

  await page.getByRole('button', { name: 'Sign in to join' }).click();
  await expect(page).toHaveURL(`${APP}/signin?next=${encodeURIComponent(`/r/${room.slug}`)}`);
  await page.getByLabel('Account name').fill(guest.name);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New agent name' })).toHaveValue(
    `${guest.name}'s agent`,
  );
  await joinByClick(page);
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`^${APP}/rooms/${room.id}$`));
  expect(await page.evaluate(() => sessionStorage.getItem('cc.pendingJoin'))).toBeNull();
  // Members see no Invite (host only, E1).
  await expect(page.getByRole('button', { name: 'Invite' })).toHaveCount(0);

  // After capture: no navigation, history entry or request carried the code.
  const afterCapture = urls.slice(1);
  expect(afterCapture.length).toBeGreaterThan(0);
  for (const url of afterCapture) expect(url).not.toContain(room.token);
  for (const url of seen) expect(url).not.toContain(room.token);
  for (const url of seen) expect(url).not.toContain('#');
  const history: string[] = [];
  // The join replaced the returning /r/<slug> entry with the room; walk back through the rest.
  for (let step = 0; step < 2; step++) {
    await page.goBack();
    history.push(page.url());
  }
  // The first entry is /r/<slug> without the code (a member opening it goes on to the room).
  expect(history[0]).toBe(`${APP}/signin?next=${encodeURIComponent(`/r/${room.slug}`)}`);
  expect(history[1]).toMatch(new RegExp(`^${APP}/(?:r/${room.slug}|rooms/${room.id})$`));
  for (const url of history) expect(url).not.toContain(room.token);
});

test('an expired or rotated invite shows a plain error and joins nothing (#31)', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  await patient(() =>
    host.request.post(`${API}/api/rooms/${room.id}/link/rotate`, {
      headers,
      data: { idempotency_key: crypto.randomUUID() },
    }),
  );
  const guest = await account(browser, 'Guest');
  const page = await guest.context.newPage();
  await page.goto(`/r/${room.slug}#${room.token}`);
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'This invite link is invalid or has expired. Ask the host for a new link.',
  );
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  expect(page.url()).not.toContain(room.token);
});

test('a long room opens at the newest message and loads older ones on scroll up', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  for (let i = 0; i < 55; i++) await post(i < 50 ? host : guest, room.id, { text: `Line ${i}` });
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await expect(message(page, 'Line 54')).toBeVisible();
  await expect(page.getByTestId('room-message')).toHaveCount(50);
  await expect.poll(() => inView(page, 'Line 54')).toBe(true);
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByTestId('room-message')).toHaveCount(55);
  await expect(message(page, 'Line 0')).toBeAttached();
  await expect.poll(() => inView(page, 'Line 5')).toBe(true);
});

test('incoming messages merge without remounting the composer; draft, focus and "New messages" hold', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  for (let i = 0; i < 12; i++) await post(host, room.id, { text: `Earlier ${i}` });
  const page = await host.context.newPage();
  await page.setViewportSize({ width: 1440, height: 560 }); // a short viewport, so 12 scroll
  await page.goto(`/rooms/${room.id}`);
  await expect(message(page, 'Earlier 11')).toBeVisible();
  const box = page.getByLabel('Message', { exact: true });
  await box.click();
  await box.pressSequentially('Draft in progress');
  await box.evaluate((element: HTMLTextAreaElement) => {
    (element as unknown as { marker: string }).marker = 'original';
    element.setSelectionRange(5, 5);
  });

  await post(guest, room.id, { text: 'Hello from the guest' });
  await pollNow(page);
  await expect(message(page, 'Hello from the guest')).toBeVisible();
  await expect.poll(() => inView(page, 'Hello from the guest')).toBe(true);
  expect(
    await box.evaluate((element: HTMLTextAreaElement) => ({
      same: (element as unknown as { marker?: string }).marker === 'original',
      focused: document.activeElement === element,
      caret: element.selectionStart,
      value: element.value,
    })),
  ).toEqual({ same: true, focused: true, caret: 5, value: 'Draft in progress' });

  // Scrolled up: no jump, a "New messages" pill instead.
  await page.getByTestId('room-scroll').evaluate((element) => {
    element.scrollTop = 100;
  });
  await page.waitForTimeout(100);
  await post(guest, room.id, { text: 'While you read' });
  await pollNow(page);
  await expect(message(page, 'While you read')).toBeAttached();
  const pill = page.getByRole('button', { name: 'New messages' });
  await expect(pill).toBeVisible();
  expect(await inView(page, 'While you read')).toBe(false);
  await pill.click();
  await expect.poll(() => inView(page, 'While you read')).toBe(true);
  await expect(box).toHaveValue('Draft in progress');
});

test('@mention picker inserts a member, Enter sends, and data parts stay behind Details', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Research agent');
  await post(guest, room.id, {
    parts: [{ type: 'data', data: { plan: 'ship rooms', owners: ['Ana', 'Lena'] } }],
  });
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await expect(list(page).getByText('Shared data: plan, owners')).toBeVisible();
  // Another person's account stays private: a friendly label, the privacy hash as a tooltip.
  const byline = list(page).getByText('· another person', { exact: true }).first();
  await expect(byline).toBeVisible();
  await expect(byline).toHaveAttribute('title', /^Account [0-9a-f]{8}$/);
  await expect(list(page).getByText('ship rooms', { exact: false })).toBeHidden();
  await list(page).getByText('Details').click();
  await expect(list(page).getByText('ship rooms', { exact: false })).toBeVisible();

  const box = page.getByLabel('Message', { exact: true });
  await box.click();
  await box.pressSequentially('Thanks @Res');
  const picker = page.getByRole('listbox', { name: 'Mention a member' });
  await expect(picker.getByRole('option')).toHaveCount(1);
  await box.press('Enter');
  await expect(box).toHaveValue('Thanks @Research agent ');
  await box.pressSequentially('can you check?');
  await box.press('Enter');
  await expect(list(page).locator('.rm-mention', { hasText: '@Research agent' })).toBeVisible();
  await expect(box).toHaveValue('');
  // Shift+Enter adds a line instead of sending.
  await box.pressSequentially('one');
  await box.press('Shift+Enter');
  await box.pressSequentially('two');
  await expect(box).toHaveValue('one\ntwo');
});

test('host Invite sheet: one /j link, copy, live join status; members get no Invite (E1)', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  await host.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: APP });
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { name: 'This room is quiet' })).toBeVisible();
  await page.getByRole('button', { name: 'Invite' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Invite to this room' });
  const field = sheet.getByLabel('Invite link');
  await expect(field).toHaveValue(/^https?:\/\/[^/]+\/j\/[A-Za-z0-9_-]{43}$/);
  // Plain words only, one short line: paste the link; a new AI connects first (no addresses).
  await expect(sheet).toContainText('Paste the link into your AI. New AI? Connect your AI first.');
  await expect(sheet.getByRole('link', { name: 'Connect your AI' })).toHaveAttribute(
    'href',
    '/#connect',
  );
  await expect(sheet).not.toContainText('/mcp');
  await sheet.getByRole('button', { name: 'Copy invite' }).click();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Join my Central City room and stay in it; reply when you're mentioned: ${await field.inputValue()}`,
  );
  // A blocked clipboard: no "Copied"; the link is selected with a keyboard hint instead.
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new Error('blocked'));
  });
  await sheet.getByRole('button', { name: 'Copy invite' }).click();
  await expect(sheet.getByText(/^Press (⌘C|Ctrl\+C) to copy$/)).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Copied' })).toHaveCount(0);
  expect(
    await field.evaluate(
      (input: HTMLInputElement) =>
        input.selectionStart === 0 && input.selectionEnd === input.value.length,
    ),
  ).toBe(true);
  await expect(sheet.getByText('Waiting for your AI…')).toBeVisible();
  // Revoke one link (#56): it stops working at once and a fresh link replaces it.
  await sheet.getByText('More options').click();
  const revoked = await field.inputValue();
  await sheet.getByRole('button', { name: 'Revoke this link' }).click();
  await sheet.getByRole('button', { name: 'Revoke link', exact: true }).click();
  await expect(sheet.getByText('The old link no longer works. This is a new one.')).toBeVisible();
  await expect(field).not.toHaveValue(revoked);
  await expect(field).toHaveValue(/\/j\/[A-Za-z0-9_-]{43}$/);
  const oldCode = new URL(revoked).pathname.split('/').pop()!;
  expect((await patient(() => host.request.get(`${API}/j/${oldCode}?format=json`))).status()).toBe(
    404,
  );

  // An AI joins with the /j code while the sheet is open.
  const guest = await account(browser, 'Guest');
  const code = new URL(await field.inputValue()).pathname.split('/').pop()!;
  await join(guest, { id: room.slug, token: code }, 'Claude agent');
  await expect(sheet.getByText('Claude agent joined')).toBeVisible();
  await sheet.getByRole('button', { name: 'Go to room' }).click();
  await expect(sheet).toHaveCount(0);
});

test('Invite sheet: "New members can read earlier messages" shows and changes the room history', async ({
  browser,
}) => {
  const host = await account(browser, 'History host');
  const room = await hostRoom(host, 'Tea room');
  const history = async () => {
    const listed = await patient(() => host.request.get(`${API}/api/rooms`, { headers }));
    const rooms = (await listed.json()).rooms as Array<{ id: string; history: string }>;
    return rooms.find((item) => item.id === room.id)!.history;
  };
  expect(await history()).toBe('full');
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole('button', { name: 'Invite' }).first().click();
  const sheet = page.getByRole('dialog', { name: 'Invite to this room' });
  // Room settings sit behind "More options" (the sheet stays minimal).
  await sheet.getByText('More options').click();
  const toggle = sheet.getByRole('checkbox', { name: 'New members can read earlier messages' });
  const notice = sheet.getByText('People and AIs who join can read the whole conversation.');
  await expect(toggle).toBeChecked();
  await expect(notice).toBeVisible();
  await toggle.uncheck();
  await expect(notice).toHaveCount(0);
  await expect.poll(history).toBe('from_join');
  await toggle.check();
  await expect(notice).toBeVisible();
  await expect.poll(history).toBe('full');
  await page.keyboard.press('Escape');

  // New room: on by default; unchecked creates a from_join room.
  await page.getByRole('button', { name: 'New room' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New room' });
  const option = dialog.getByRole('checkbox', { name: 'New members can read earlier messages' });
  await expect(option).toBeChecked();
  await dialog.getByLabel('Room name').fill('Quiet corner');
  await option.uncheck();
  await dialog.getByRole('button', { name: 'Create room' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () => {
      const listed = await patient(() => host.request.get(`${API}/api/rooms`, { headers }));
      const rooms = (await listed.json()).rooms as Array<{ name: string; history: string }>;
      return rooms.find((item) => item.name === 'Quiet corner')?.history;
    })
    .toBe('from_join');
});

test('first paint survives a transient 429: the room opens without the list and retries fast', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  await post(host, room.id, { text: 'Still here after a hiccup' });
  const page = await host.context.newPage();
  const limited = { list: 2, read: 1 };
  await page.route('**/api/rooms', (route) =>
    route.request().method() === 'GET' && limited.list-- > 0
      ? route.fulfill({ status: 429, headers: { 'retry-after': '1' }, json: { error: 'x' } })
      : route.continue(),
  );
  await page.route(`**/api/rooms/${room.id}/messages?*`, (route) =>
    limited.read-- > 0 ? route.fulfill({ status: 503, json: { error: 'x' } }) : route.continue(),
  );
  const started = Date.now();
  await page.goto(`/rooms/${room.id}`);
  // The list is still failing, yet the room renders from its own first read, within seconds.
  await expect(message(page, 'Still here after a hiccup')).toBeVisible({ timeout: 6_000 });
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  expect(Date.now() - started).toBeLessThan(6_000);
  await expect(
    page.getByRole('navigation', { name: 'Rooms' }).getByText('Launch plan'),
  ).toBeVisible({
    timeout: 10_000,
  });
});

test('the shell can open a room with the Invite sheet already open (#73)', async ({ browser }) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  // What the shell's "Invite your AI" does: push the room with { invite: true }.
  await page.evaluate((id) => {
    history.pushState({ invite: true }, '', `/rooms/${id}`);
    location.reload();
  }, room.id);
  await expect(page.getByRole('dialog', { name: 'Invite to this room' })).toBeVisible();
  await page.getByRole('button', { name: 'Close' }).click();
  await page.reload(); // opened once: the state was cleared
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Invite to this room' })).toHaveCount(0);
});

test('lost and failed sends: a refresh reconciles the server copy, Retry posts once; closed rooms are read-only (#31)', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  const posts: string[] = [];
  let mode: 'lose-response' | 'fail' | 'pass' = 'lose-response';
  await page.route(`**/api/rooms/${room.id}/messages`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts.push(route.request().postDataJSON().idempotency_key);
    if (mode === 'lose-response') {
      mode = 'pass';
      await route.fetch(); // The server commits the post; the response is lost.
      return route.abort('failed');
    }
    if (mode === 'fail') {
      mode = 'pass';
      return route.abort('failed'); // Never reaches the server.
    }
    return route.continue();
  });
  const box = page.getByLabel('Message', { exact: true });
  const serverCount = async (text: string) =>
    (
      await (await patient(() => host.request.get(`${API}/api/rooms/${room.id}/messages`))).json()
    ).messages.filter((item: { text: string }) => item.text === text).length;

  // 1. Lost response: the next refresh brings the server copy; it replaces the pending one.
  await box.fill('Committed but unconfirmed');
  await box.press('Enter');
  await expect(page.getByText(/^Not sent\./)).toBeVisible();
  await pollNow(page);
  await expect(message(page, 'Committed but unconfirmed')).toHaveCount(1);
  await expect(page.getByTestId('room-message-pending')).toHaveCount(0);
  await expect(page.getByText(/^Not sent\./)).toHaveCount(0);
  expect(await serverCount('Committed but unconfirmed')).toBe(1);

  // 2. Failed before the server: Retry sends with the same key, exactly once.
  mode = 'fail';
  await box.fill('Retried once');
  await box.press('Enter');
  await expect(page.getByText(/^Not sent\./)).toBeVisible();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(message(page, 'Retried once')).toHaveCount(1);
  await expect(page.getByTestId('room-message-pending')).toHaveCount(0);
  expect(posts.at(-1)).toBe(posts.at(-2));
  expect(await serverCount('Retried once')).toBe(1);

  await patient(() =>
    host.request.post(`${API}/api/rooms/${room.id}/close`, { headers, data: {} }),
  );
  await pollNow(page);
  await expect(page.getByText('This room is closed. Its history stays readable.')).toBeVisible();
  await expect(box).toHaveCount(0);
});

test('a code from a shared /j/<code> link joins through /r/<slug>#<code> without leaking', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const created = await patient(() =>
    host.request.post(`${API}/api/links`, {
      headers,
      data: { target: 'room', room_id: room.id },
    }),
  );
  expect(created.status()).toBe(201);
  const code = new URL((await created.json()).url).pathname.split('/').pop()!;
  // What the /j page's "Join room" button (and its JSON human_url) points to.
  const document = await (
    await patient(() => host.request.get(`${API}/j/${code}?format=json`))
  ).json();
  const human = new URL(document.human_url);
  expect(human.pathname).toBe(`/r/${room.slug}`);
  expect(human.hash).toBe(`#${code}`);

  const guest = await account(browser, 'Guest');
  const page = await guest.context.newPage();
  const seen: string[] = [];
  page.on('request', (request) => seen.push(request.url(), request.headers()['referer'] ?? ''));
  await page.goto(`${human.pathname}${human.hash}`);
  await expect(page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  expect(page.url()).toBe(`${APP}/r/${room.slug}`);
  await joinByClick(page);
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  for (const url of seen) expect(url).not.toContain(code);
  expect(await page.evaluate(() => sessionStorage.getItem('cc.pendingJoin'))).toBeNull();
});

test('"Join as" retry with a different agent uses a new idempotency key', async ({ browser }) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  await agent(guest, 'Existing agent');
  const page = await guest.context.newPage();
  const keys: string[] = [];
  let failFirst = true;
  await page.route('**/api/rooms/*/join', async (route) => {
    keys.push(route.request().postDataJSON().idempotency_key);
    if (failFirst) {
      failFirst = false;
      return route.fulfill({ status: 503, json: { error: 'Temporarily unavailable' } });
    }
    return route.continue();
  });
  await page.goto(`/r/${room.slug}#${room.token}`);
  await expect(page.getByRole('radio', { name: 'Existing agent' })).toBeChecked();
  await page.getByRole('button', { name: 'Join room' }).click();
  await expect(page.getByRole('alert')).toHaveText("We couldn't reach Central City. Try again.");
  await page.getByRole('radio', { name: 'A new agent named' }).check();
  await joinByClick(page);
  await expect(page.getByRole('heading', { name: 'Launch plan', level: 1 })).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]);
});

test('an expired pending code is removed and the page asks for the link again', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host);
  const guest = await account(browser, 'Guest');
  const page = await guest.context.newPage();
  await page.goto(`/r/${room.slug}#${room.token}`);
  await expect(page.getByRole('heading', { name: 'Join the room' })).toBeVisible();
  await page.evaluate(() => {
    const value = JSON.parse(sessionStorage.getItem('cc.pendingJoin')!);
    sessionStorage.setItem(
      'cc.pendingJoin',
      JSON.stringify({ ...value, at: value.at - 31 * 60_000 }),
    );
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Open your invite link' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('cc.pendingJoin'))).toBeNull();
});

test('mobile: the sidebar is a drawer and nothing scrolls sideways', async ({ browser }) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Research desk');
  await post(host, room.id, { text: 'A message that is long enough to wrap on a phone screen.' });
  const page = await host.context.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/rooms/${room.id}`);
  await expect(
    message(page, 'A message that is long enough to wrap on a phone screen.'),
  ).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Rooms' })).not.toBeInViewport();
  await page.getByRole('button', { name: 'Open menu' }).click();
  await expect(page.getByRole('navigation', { name: 'Rooms' })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('own messages are a grey bubble on the right; everyone else stays left, document style', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Bubble room');
  const guest = await account(browser, 'Guest');
  await join(guest, room, 'Guest agent');
  await post(guest, room.id, { text: 'A note from the guest.' });
  await post(host, room.id, { text: 'My own note.' });
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  const mine = list(page).getByTestId('room-message').filter({ hasText: 'My own note.' });
  const theirs = list(page)
    .getByTestId('room-message')
    .filter({ hasText: 'A note from the guest.' });
  await expect(mine).toBeVisible();
  await expect(mine.locator('.rm-own-bubble')).toHaveCount(1);
  await expect(mine.locator('.rm-byline, .rm-avatar')).toHaveCount(0);
  await expect(theirs.locator('.rm-own-bubble')).toHaveCount(0);
  await expect(theirs.locator('.rm-byline')).toContainText('Guest agent');
  const [thread, own, other] = await Promise.all([
    list(page).boundingBox(),
    mine.locator('.rm-own-bubble').boundingBox(),
    theirs.locator('.rm-bubble').boundingBox(),
  ]);
  expect(thread!.x + thread!.width - (own!.x + own!.width)).toBeLessThanOrEqual(2);
  expect(own!.width).toBeLessThan(thread!.width * 0.8);
  expect(other!.x - thread!.x).toBeLessThan(thread!.width / 4);
});

test('room top bar: Room list link, Connect AI and Invite, no pinned bar, no composer hint', async ({
  browser,
}) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Top bar room');
  await post(host, room.id, { text: 'First note in the room.' });
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await expect(message(page, 'First note in the room.')).toBeVisible();
  const head = page.locator('.rm-room-head');
  const roomList = head.getByRole('link', { name: 'Room list', exact: true });
  await expect(roomList).toBeVisible();
  await expect(roomList).toHaveAttribute('href', '/rooms');
  await expect(head.getByRole('button', { name: 'Connect AI' })).toBeVisible();
  await expect(head.getByRole('button', { name: 'Invite', exact: true })).toBeVisible();
  // Exactly one filled button; the room name is a heading for assistive technology only.
  await expect(head.locator('.rm-primary')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1, name: 'Top bar room' })).toHaveCount(1);
  const title = await head.locator('h1').boundingBox();
  expect(title && title.width <= 1 && title.height <= 1).toBe(true);
  // No pinned bar; the safety notice stays.
  await expect(page.getByText(/pinned/i)).toHaveCount(0);
  await expect(
    page.getByText("Messages here come from other people's AIs.", { exact: false }),
  ).toBeVisible();
  // The composer has no hint text; Enter still sends.
  const composer = page.getByRole('form', { name: 'Message composer' });
  await expect(composer).not.toContainText(/Enter to send|Markdown supported|Shift\s*\+\s*Enter/i);
  const box = composer.getByLabel('Message', { exact: true });
  await composer.getByRole('button', { name: 'Mention a member' }).click();
  await expect(box).toHaveValue('@');
  // The only other member is your own host agent, which you never @mention: no picker.
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
  await box.fill('');
  await composer.getByRole('button', { name: 'Insert code block' }).click();
  await expect(box).toHaveValue('```\n\n```');
  await box.fill('Sent with Enter.');
  await box.press('Enter');
  await expect(message(page, 'Sent with Enter.')).toBeVisible();
  // The "…" menu opens the Room settings panel.
  await head.getByRole('button', { name: 'More room actions' }).click();
  await page.getByRole('menuitem', { name: 'Room settings', exact: true }).click();
  await expect(page.getByRole('complementary', { name: 'Room settings' })).toBeVisible();
  await roomList.click();
  await expect(page).toHaveURL(/^https?:\/\/[^/]+\/rooms$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Your rooms' })).toBeVisible();
});

test('Connect AI sheet shows the real connection address and commands', async ({ browser }) => {
  const host = await account(browser, 'Host');
  const room = await hostRoom(host, 'Connect room');
  const page = await host.context.newPage();
  await page.goto(`/rooms/${room.id}`);
  await page.getByRole('button', { name: 'Connect AI' }).click();
  const sheet = page.getByRole('dialog', { name: 'Connect your AI' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Bring your own AI into this room.');
  // A local server: the Connect page's one-click address is this origin's /mcp.
  const endpoint = `${APP}/mcp`;
  await expect(
    sheet.getByText(`claude mcp add --transport http central-city ${endpoint}`, { exact: true }),
  ).toBeVisible();
  await expect(
    sheet.getByText(`codex mcp add central-city --url ${endpoint}`, { exact: true }),
  ).toBeVisible();
  // One-click installs open the HTTPS install pages (a bare cursor: or vscode: link does
  // nothing without the app) in a new tab.
  const cursor = sheet.getByRole('link', { name: 'Add to Cursor' });
  await expect(cursor).toHaveAttribute(
    'href',
    `https://cursor.com/en/install-mcp?name=central-city&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url: endpoint })).toString('base64'))}`,
  );
  const vscode = sheet.getByRole('link', { name: 'Install in VS Code' });
  await expect(vscode).toHaveAttribute(
    'href',
    `https://vscode.dev/redirect/mcp/install?name=central-city&config=${encodeURIComponent(JSON.stringify({ type: 'http', url: endpoint }))}`,
  );
  for (const link of [cursor, vscode]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(sheet.getByRole('link', { name: 'All connection options' })).toHaveAttribute(
    'href',
    '/#connect',
  );
  // Nothing invented: no bridge addresses, sockets or custom GPTs.
  await expect(sheet).not.toContainText(/wss?:\/\/|bridge|Custom GPT/i);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // The host continues to the room's invite link.
  await page.getByRole('button', { name: 'Connect AI' }).click();
  await sheet.getByRole('button', { name: 'Get the invite link' }).click();
  await expect(page.getByLabel('Invite link')).toHaveValue(/\/j\//);
});

test('screenshots: room, invite sheet and join screen at 1440 and 390, light and dark', async ({
  browser,
}) => {
  // Evidence only (no product assertion beyond the other tests): four reloads at the end of a
  // shared-limit suite can meet a 429, so it runs on request: SCREENSHOTS=1.
  test.skip(!process.env.SCREENSHOTS, 'screenshots run with SCREENSHOTS=1');
  const host = await account(browser, 'Ana');
  const room = await hostRoom(host, 'Launch plan');
  const guest = await account(browser, 'Lena');
  await join(guest, room, 'Research agent');
  await post(guest, room.id, {
    text: 'Found three sources on edge caching. @Host agent can you check the second one? https://example.com/edge-caching',
  });
  await post(host, room.id, { text: 'Checked. The second one is from 2023; still accurate.' });
  await post(guest, room.id, {
    parts: [
      { type: 'text', text: 'Here is the plan with owners and dates.' },
      { type: 'data', data: { plan: 'ship rooms', owners: ['Ana', 'Lena'], dates: ['Oct 1'] } },
    ],
  });
  await post(host, room.id, { text: 'Looks good. I will take the invite sheet.' });
  const shots = process.env.SCREENSHOTS_DIR || 'test-results';
  for (const scheme of ['light', 'dark'] as const)
    for (const width of [1440, 390]) {
      // The harness has no theme script: set the theme attribute the shell would set.
      const page = await host.context.newPage();
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/rooms/${room.id}`);
      await expect(message(page, 'Looks good. I will take the invite sheet.')).toBeVisible();
      await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), scheme);
      await page.screenshot({ path: `${shots}/rooms-${width}-${scheme}.png` });
      await page.getByRole('button', { name: /^Members, / }).click();
      await expect(page.getByRole('complementary', { name: 'Members' })).toBeVisible();
      await page.screenshot({ path: `${shots}/rooms-members-${width}-${scheme}.png` });
      await page.getByRole('button', { name: 'Close members' }).click();
      await page.getByRole('button', { name: 'Connect AI' }).click();
      await expect(page.getByRole('dialog', { name: 'Connect your AI' })).toBeVisible();
      await page.screenshot({ path: `${shots}/rooms-connect-${width}-${scheme}.png` });
      await page.keyboard.press('Escape');
      if (width === 1440 && scheme === 'light') {
        await page.getByRole('button', { name: 'Invite', exact: true }).click();
        await expect(page.getByLabel('Invite link')).toHaveValue(/\/j\//);
        await page.screenshot({ path: `${shots}/rooms-invite-${width}-${scheme}.png` });
      }
      await page.close();
    }
  const joiner = await account(browser, 'Sam');
  await joiner.context.clearCookies();
  const joinPage = await joiner.context.newPage();
  await joinPage.setViewportSize({ width: 390, height: 844 });
  await joinPage.goto(`/r/${room.slug}#${room.token}`);
  await expect(joinPage.getByRole('button', { name: 'Sign in to join' })).toBeVisible();
  await joinPage.screenshot({ path: `${shots}/rooms-join-390-light.png` });
});
