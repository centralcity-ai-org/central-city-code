import {
  test,
  expect,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

/*
 * Scrolling to the top of a long room while the background poll is in flight still loads the
 * older page: older() queues behind the poll instead of being dropped (rooms.spec.ts:331 flake).
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

/**
 * The test server allows each address 600 API requests a minute across the whole suite (all
 * specs share 127.0.0.1), so setup calls wait out a 429 (Retry-After) like rooms.spec.ts does,
 * instead of failing on earlier specs' traffic.
 */
async function patient(call: () => Promise<APIResponse>): Promise<APIResponse> {
  for (let attempt = 0; ; attempt++) {
    const response = await call();
    if (response.status() !== 429 || attempt >= 6) return response;
    const wait = Number(response.headers()['retry-after'] ?? '5');
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(wait, 1), 20) * 1000));
  }
}
/** Status and body in the assertion message, so a CI failure says why. */
const why = async (response: APIResponse) =>
  `${response.status()} ${(await response.text()).slice(0, 300)}`;
/** Every context a test opens is closed after it: no page keeps polling into later specs. */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((context) => context.close()));
});

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  opened.push(context);
  const created = await patient(() =>
    context.request.post('/api/auth/register', {
      headers,
      data: { name: `${label}-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const agent = await patient(() =>
    context.request.post('/api/agents', {
      headers,
      data: { name: `${label} agent`, capability: 'research', mode: 'external' },
    }),
  );
  expect(agent.ok(), await why(agent)).toBeTruthy();
  return { context, request: context.request, agentId: (await agent.json()).agent.id as string };
}

test('scrolling up during a poll still loads the older messages', async ({ browser }) => {
  const host = await account(browser, 'Older-host');
  const created = await patient(() =>
    host.request.post('/api/rooms', {
      headers,
      data: {
        agent_id: host.agentId,
        name: 'Older poll room',
        idempotency_key: crypto.randomUUID(),
      },
    }),
  );
  expect(created.status(), await why(created)).toBe(201);
  const roomId = (await created.json()).room.id as string;
  for (let i = 0; i < 55; i++) {
    const key = crypto.randomUUID(); // one key, so a retried post never posts twice
    const res = await patient(() =>
      host.request.post(`/api/rooms/${roomId}/messages`, {
        headers,
        data: { text: `Line ${i}`, idempotency_key: key },
      }),
    );
    expect(res.status(), await why(res)).toBe(201);
  }

  const page = await host.context.newPage();
  // Hold the thread's first background poll (a forward read of up to 100) open until released.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let pollStarted!: () => void;
  const polling = new Promise<void>((resolve) => (pollStarted = resolve));
  let holding = true;
  await page.route(/\/api\/rooms\/[^/]+\/messages\?since=\d+&limit=100\b/, async (route) => {
    // The thread's poll reads forward from its newest message (since ≥ 50); the sidebar's unread
    // lookup reads from the read mark and is not held.
    const since = Number(new URL(route.request().url()).searchParams.get('since'));
    if (holding && since >= 50) {
      holding = false;
      pollStarted();
      await held;
    }
    await route.continue();
  });

  await page.goto(`/rooms/${roomId}`);
  const list = page.getByTestId('room-message');
  await expect(list).toHaveCount(50);
  await polling; // the poll is in flight now
  // Scroll to the top and wait until the scroll event (where the list asks for older messages)
  // has been handled, before the poll is released.
  await page.getByTestId('room-scroll').evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener(
          'scroll',
          () => requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          { once: true },
        );
        element.scrollTop = 0;
      }),
  );
  release();
  await expect(list).toHaveCount(55);
  await expect(page.getByTestId('room-scroll').getByText('Line 0', { exact: true })).toBeAttached();
});
