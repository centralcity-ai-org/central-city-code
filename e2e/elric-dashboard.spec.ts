import { test, expect, type Page, type Route } from '@playwright/test';
import { ELRIC_AI_TAG } from '../shared/elric-copy';

/*
 * The /elric dashboard (docs/ELRIC.md "Dashboard chat"). The e2e server runs without CITY_ELRIC,
 * so /api/elric* and the chat room's message routes are served by page.route with the shapes of
 * server/elric/chat.ts and the rooms routes; tests/elric-chat.test.ts covers the real routes.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };
const CHAT = 'c4a1e2f0-1b2c-4d3e-8f90-0a1b2c3d4e5f';
const PERSON = 'p-member-1';
const SHARED = { id: 'r-shared-1', name: 'Weekly planning' };

type Msg = { seq: number; own: boolean; text: string; model?: string };

async function mockElric(
  page: Page,
  opts: {
    messages?: Msg[];
    pending?: boolean;
    silent?: boolean;
    powerFails?: boolean;
    paused?: boolean;
  } = {},
) {
  const state = {
    messages: [...(opts.messages ?? [])],
    posts: [] as Array<{ room: string; body: Record<string, unknown> }>,
    asks: [] as unknown[],
    power: [] as string[],
    decisions: [] as Array<[string, unknown]>,
    pending: opts.pending
      ? [
          {
            id: 'a6f3c1d2-4b5e-4f60-9a71-8b2c3d4e5f60',
            tool: 'room_task_create',
            summary: 'Create task: Update the onboarding checklist',
            args_hash: 'a'.repeat(64),
            room: SHARED,
            created_at: '2026-10-01T09:00:00.000Z',
            expires_at: '2026-10-01T09:10:00.000Z',
          },
        ]
      : [],
  };
  const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const message = (item: Msg) => ({
    id: `m-${item.seq}`,
    seq: item.seq,
    origin: 'external',
    sender: item.own ? 'You' : 'Elric',
    sender_agent_id: item.own ? PERSON : 'elric-agent',
    sender_owner_label: 'You',
    own: true,
    text: item.text,
    parts: [{ type: 'text', text: item.text }],
    created_at: '2026-10-01T09:00:00.000Z',
    format: 'markdown',
    auto_reply: item.own ? null : { provider: 'elric', model: item.model ?? 'gemma-4-12b' },
  });
  const latest = () => state.messages.at(-1)?.seq ?? 0;
  await page.route('**/api/elric', (route) =>
    json(route, { agent_id: 'elric-agent', status: 'active' }),
  );
  await page.route('**/api/elric/chat*', (route) =>
    json(route, {
      room_id: CHAT,
      slug: 'elric-chat',
      person_member_id: PERSON,
      status: opts.paused ? 'paused' : 'active',
      latest_seq: latest(),
      waking: false,
      pending_count: state.pending.length,
    }),
  );
  for (const action of ['pause', 'resume'] as const)
    await page.route(`**/api/elric/${action}`, (route) => {
      state.power.push(action);
      if (opts.powerFails) return json(route, { error: 'x' }, 500);
      return json(route, {
        agent_id: 'elric-agent',
        status: action === 'pause' ? 'paused' : 'active',
      });
    });
  await page.route('**/api/elric/rooms', (route) =>
    json(route, { rooms: [{ ...SHARED, member_count: 3, hosting: true, elric_member: true }] }),
  );
  await page.route('**/api/elric/ask', (route) => {
    state.asks.push(route.request().postDataJSON());
    return json(route, { room_id: SHARED.id, person_member_id: 'p-shared', posts_publicly: true });
  });
  await page.route('**/api/elric/pending', (route) => json(route, { pending: state.pending }));
  await page.route('**/api/elric/pending/*/*', (route) => {
    const [, , , , id, decision] = new URL(route.request().url()).pathname.split('/');
    state.decisions.push([decision!, route.request().postDataJSON()]);
    state.pending = state.pending.filter((item) => item.id !== id);
    return json(route, { id, status: decision === 'approve' ? 'approved' : 'rejected' });
  });
  await page.route('**/api/rooms/*/messages*', (route) => {
    const room = new URL(route.request().url()).pathname.split('/')[3]!;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      state.posts.push({ room, body });
      const posted = { seq: latest() + 1, own: true, text: String(body.text) };
      if (room === CHAT) {
        state.messages.push(posted);
        // Elric answers on the next poll (unless the turn fails: `silent`).
        if (!opts.silent)
          state.messages.push({
            seq: posted.seq + 1,
            own: false,
            text: 'Here is a **short** answer.',
          });
      }
      return json(route, { message: message(posted) }, 201);
    }
    const since = Number(new URL(route.request().url()).searchParams.get('since') ?? 0);
    const list = state.messages.filter((item) => item.seq > since).map(message);
    return json(route, {
      room: {
        id: CHAT,
        slug: 'elric-chat',
        name: 'Elric',
        topic: '',
        role: 'host',
        closed: false,
        history: 'full',
        member_count: 2,
        latest_seq: latest(),
        created_at: '2026-10-01T09:00:00.000Z',
      },
      messages: list,
      latest_seq: latest(),
      visible_from_seq: 0,
      next_since: latest(),
      has_more: false,
    });
  });
  return state;
}

async function signIn(page: Page) {
  const created = await page.request.post('/api/auth/register', {
    headers,
    data: { name: `Dash-owner-${crypto.randomUUID().slice(0, 8)}`, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
}

test('without Elric on the server, /elric is not found', async ({ page }) => {
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByText('This page doesn’t exist.')).toBeVisible();
});

test('empty chat: one line, three chips, a minimal header and a disabled send', async ({
  page,
}) => {
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'Elric', level: 1 })).toBeVisible();
  await expect(page.locator('.elx-title .elx-tag')).toHaveText(ELRIC_AI_TAG);
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  await expect(page.locator('.elx-chip')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'New chat' })).toBeVisible();
  const send = page.getByRole('button', { name: 'Send' });
  await expect(send).toBeDisabled();
  await page.locator('.elx-chip').first().click();
  await expect(page.getByLabel('Message Elric')).toHaveValue('Summarize my latest room');
  await expect(send).toBeEnabled();
  // No internal wording on the page.
  await expect(page.locator('body')).not.toContainText(/Status:|dispatch|#\d{3,}/);
});

test('a message posts "@Elric …" as the person member and the reply shows its label', async ({
  page,
}) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('What changed this week?');
  await page.keyboard.press('Enter');
  await expect(page.locator('.elx-bubble')).toHaveText('What changed this week?');
  expect(state.posts[0]).toMatchObject({
    room: CHAT,
    body: { text: '@Elric What changed this week?', agent_id: PERSON },
  });
  // The dots show at once in Elric's place and go when the reply lands.
  const thinking = page.getByTestId('elric-thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toHaveAttribute('aria-live', 'polite');
  await expect(thinking).toContainText('Elric is thinking');
  await expect(page.getByTestId('elric-reply')).toContainText('short answer', { timeout: 10_000 });
  await expect(thinking).toHaveCount(0);
  const byline = page.locator('.elx-byline');
  await expect(byline).toHaveText(/^Elric\s*AI$/);
  await expect(byline).toHaveAttribute('title', 'Elric v1.0');
  // No model name anywhere users see.
  await expect(page.locator('body')).not.toContainText('gemma');
  // The reply's last line is not under the composer.
  const reply = await page.getByTestId('elric-reply').boundingBox();
  const dock = await page.locator('.elx-composer').boundingBox();
  expect(reply!.y + reply!.height).toBeLessThanOrEqual(dock!.y);
});

test('a proposed action waits for approval: Approve sends the args hash', async ({ page }) => {
  const state = await mockElric(page, {
    pending: true,
    messages: [
      { seq: 1, own: true, text: '@Elric Make a task for the checklist' },
      { seq: 2, own: false, text: 'I proposed a task. Approve it to create it.' },
    ],
  });
  await signIn(page);
  await page.goto('/elric');
  const card = page.getByTestId('elric-pending');
  await expect(card).toContainText('Waiting for your approval');
  await expect(card).toContainText('Update the onboarding checklist');
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toHaveCount(0);
  expect(state.decisions[0]).toEqual(['approve', { args_hash: 'a'.repeat(64) }]);
});

test('"@ room" asks the server first and posts in that room', async ({ page }) => {
  const state = await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await page.getByRole('button', { name: 'Ask in a room' }).click();
  await page.getByRole('option', { name: SHARED.name }).click();
  await page.getByLabel('Message Elric').fill('Summarize today');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toContainText(`Posted in ${SHARED.name}`);
  expect(state.asks).toEqual([{ room_id: SHARED.id }]);
  expect(state.posts[0]).toMatchObject({
    room: SHARED.id,
    body: { text: '@Elric Summarize today', agent_id: 'p-shared' },
  });
});

test('mobile: header and composer fit on one row at 390px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByRole('heading', { name: 'What can I help with?' })).toBeVisible();
  const header = await page.locator('.elx-header').boundingBox();
  expect(header!.height).toBeLessThanOrEqual(57);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(390);
});

test('a long thread and a 6-line draft: the last reply stays above the composer', async ({
  page,
}) => {
  const messages: Msg[] = [];
  for (let seq = 1; seq <= 24; seq += 2) {
    messages.push({ seq, own: true, text: `@Elric Question ${seq}` });
    messages.push({ seq: seq + 1, own: false, text: `Answer ${seq + 1}.\n\nA second paragraph.` });
  }
  await mockElric(page, { messages });
  // A slow machine: the Markdown renderer arrives late, so replies grow after the first scroll.
  await page.route(/\/assets\/Markdown-[^/]*\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.getByTestId('elric-reply').last()).toContainText('Answer 24');
  const lastAboveDock = async () => {
    const reply = await page.getByTestId('elric-reply').last().boundingBox();
    const dock = await page.locator('.elx-dock').boundingBox();
    return reply!.y + reply!.height <= dock!.y;
  };
  // Right after loading, before any draft.
  await expect.poll(lastAboveDock).toBe(true);
  await page
    .getByLabel('Message Elric')
    .fill(['one', 'two', 'three', 'four', 'five', 'six'].join('\n'));
  await expect
    .poll(async () => {
      const reply = await page.getByTestId('elric-reply').last().boundingBox();
      const dock = await page.locator('.elx-dock').boundingBox();
      return reply!.y + reply!.height <= dock!.y;
    })
    .toBe(true);
  // Elric's replies (own:true for the owner) never render as the person's bubble.
  await expect(page.locator('.elx-bubble')).toHaveCount(12);
});

test('a turn that never answers: quiet lines at 10 s and 30 s, then an error with Try again', async ({
  page,
}) => {
  await page.clock.install();
  const state = await mockElric(page, { silent: true });
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('Hello');
  await page.keyboard.press('Enter');
  const thinking = page.getByTestId('elric-thinking');
  await expect(thinking).toBeVisible();
  await expect(thinking).toContainText('Elric');
  await expect(thinking.locator('.cc-thinking-line')).toHaveCount(0);
  await page.clock.fastForward(11_000);
  await expect(thinking.locator('.cc-thinking-line')).toHaveText('Thinking…');
  await page.clock.fastForward(20_000);
  await expect(thinking.locator('.cc-thinking-line')).toHaveText('Still working on it…');
  // Within the 55 s run budget it keeps waiting; after it, the plain error and Try again.
  await page.clock.fastForward(20_000);
  await expect(thinking).toBeVisible();
  await page.clock.fastForward(10_000);
  await expect(thinking).toHaveCount(0);
  await expect(page.getByText('Elric didn’t answer.')).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(thinking).toBeVisible();
  expect(state.posts.map((post) => post.body.text)).toEqual(['@Elric Hello', '@Elric Hello']);
});

test('the name opens the about sheet with the version; Escape closes it', async ({ page }) => {
  await mockElric(page);
  await signIn(page);
  await page.goto('/elric');
  const name = page.getByRole('button', { name: 'Elric', exact: true });
  await expect(name).toHaveAttribute('title', 'Elric v1.0');
  await name.click();
  const sheet = page.getByRole('dialog', { name: 'Elric · Version 1.0' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'OK' })).toBeFocused();
  await expect(page.locator('body')).not.toContainText('gemma');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(name).toBeFocused();
});

test('no on/off switch in the /elric header; a paused Elric points to Manage Elric', async ({
  page,
}) => {
  await mockElric(page, { paused: true });
  await signIn(page);
  await page.goto('/elric');
  await expect(page.locator('.elx-header').getByRole('switch')).toHaveCount(0);
  await expect(page.getByLabel('Message Elric')).toBeDisabled();
  await expect(page.getByText(/Elric is paused\./)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Resume it in Manage Elric' })).toHaveAttribute(
    'href',
    '/',
  );
});

test('with reduced motion the thinking indicator is one still dot', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mockElric(page, { silent: true });
  await signIn(page);
  await page.goto('/elric');
  await page.getByLabel('Message Elric').fill('Hello');
  await page.keyboard.press('Enter');
  const dots = page.getByTestId('elric-thinking').locator('.cc-thinking-dots > span');
  await expect(dots.first()).toBeVisible();
  await expect(dots.nth(1)).toBeHidden();
  expect(await dots.first().evaluate((dot) => getComputedStyle(dot).animationName)).toBe('none');
});
