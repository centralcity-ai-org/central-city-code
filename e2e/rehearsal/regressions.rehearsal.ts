import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { ELRIC_AI_NOTICE } from '../../shared/elric-copy';

/*
 * Elric production QA regressions, end to end on the local rehearsal server
 * (e2e/rehearsal/server.ts: the real app, a fake Google, CITY_ELRIC_MOCK). Nothing is mocked in
 * the browser: accounts, the Google link, the date of birth, joins, posts and approvals all go
 * through the real routes.
 *
 * - B1: a consequential request shows an approval card; Approve creates the task, Reject doesn't.
 * - B3: the owner sees Elric's reply as Elric with the AI tag, never as their own "(you)".
 * - B5: nobody posts as Elric: the API refuses (403 elric_posts_itself), the picker hides it.
 * - B6: the AI notice on Add Elric and on first meeting Elric in a room.
 *
 * The UI checks of B1, B3 and B6 wait for their fixes (room UI PRs); each is a `fixme` until the
 * fix is in this checkout, then it runs. Local only: never against a preview.
 */
test.skip(Boolean(process.env.E2E_BASE_URL), 'Local only (the rehearsal server).');
test.describe.configure({ mode: 'serial' });

const fakePort = Number(process.env.E2E_REHEARSAL_FAKE_PORT);
const PASSWORD = `Regression-${randomBytes(18).toString('base64url')}`;
const H = { 'x-city-request': '1' };
const run = randomUUID().slice(0, 8);
const src = (path: string) => readFileSync(join('src', path), 'utf8');
const roomsSource = () =>
  readdirSync('src/rooms', { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => src(join('rooms', file)))
    .join('\n');
// The fixes, detected in this checkout.
const FIXED = {
  B1: existsSync('src/rooms/elric/ElricApprovalCard.tsx'),
  B3: /message\.own && !isElric/.test(src('rooms/MessageList.tsx')),
  B6: roomsSource().includes('ELRIC_AI_NOTICE'),
};

let owner: BrowserContext;
let page: Page;
let roomId = '';
let person = '';
let elricId = '';
let hostAgent = '';

async function call<T = Record<string, unknown>>(
  context: BrowserContext,
  method: 'GET' | 'POST',
  path: string,
  data?: unknown,
) {
  const response = await context.request.fetch(path, {
    method,
    headers: H,
    ...(data !== undefined ? { data } : {}),
  });
  const text = await response.text();
  let body = {} as T;
  try {
    body = JSON.parse(text) as T;
  } catch {
    // not JSON
  }
  return { status: response.status(), body, text };
}

async function say(text: string, agentId = person) {
  const res = await call<{ message: { seq: number } }>(
    owner,
    'POST',
    `/api/rooms/${roomId}/messages`,
    { text, agent_id: agentId, idempotency_key: randomUUID() },
  );
  return res;
}

type Message = {
  seq: number;
  text: string;
  sender_agent_id: string;
  own?: boolean;
  auto_reply?: { provider: string; pending_id?: string } | null;
};
async function messages(): Promise<Message[]> {
  return (
    await call<{ messages: Message[] }>(owner, 'GET', `/api/rooms/${roomId}/messages?since=0`)
  ).body.messages;
}
async function tasks(): Promise<string[]> {
  return (
    await call<{ tasks: Array<{ title: string }> }>(owner, 'GET', `/api/rooms/${roomId}/tasks`)
  ).body.tasks.map((task) => task.title);
}
async function waitForElricReply(after: number) {
  let reply: Message | undefined;
  await expect
    .poll(async () => {
      reply = (await messages()).find(
        (m) => m.sender_agent_id === elricId && Number(m.seq) > after,
      );
      return Boolean(reply);
    })
    .toBe(true);
  return reply!;
}

test.afterAll(async () => owner?.close());

test('setup: a Google-linked owner hosts a room (no date of birth yet)', async ({ browser }) => {
  owner = await browser.newContext();
  page = await owner.newPage();
  const created = await call(owner, 'POST', '/api/auth/register', {
    name: `Regression owner ${run}`,
    password: PASSWORD,
  });
  expect(created.status).toBe(201);
  await page.route('https://accounts.google.com/**', (route) => {
    const search = new URL(route.request().url()).searchParams;
    search.set('e2e_sub', '400000000000000000001');
    return route.fulfill({
      status: 302,
      headers: { location: `http://127.0.0.1:${fakePort}/authorize?${search}` },
    });
  });
  await page.goto('/settings/account');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('status')).toHaveText('Google account linked.');
  const agent = await call<{ agent: { id: string } }>(owner, 'POST', '/api/agents', {
    name: `Regression host ${run}`,
    capability: 'research',
    mode: 'hosted',
  });
  expect(agent.status).toBe(201);
  hostAgent = agent.body.agent.id;
  const room = await call<{ room: { id: string }; link: { link: string } }>(
    owner,
    'POST',
    '/api/rooms',
    { agent_id: hostAgent, name: `Regressions ${run}`, idempotency_key: randomUUID() },
  );
  expect(room.status).toBe(201);
  roomId = room.body.room.id;
  // The owner's person member (only a person's mention invokes Elric).
  const joined = await call(owner, 'POST', '/api/rooms/join', {
    link: room.body.link.link,
    name: `Regression owner ${run}`,
    idempotency_key: randomUUID(),
  });
  expect(joined.status, joined.text).toBe(200);
  const members = await call<{ members: Array<{ id: string; kind: string; own: boolean }> }>(
    owner,
    'GET',
    `/api/rooms/${roomId}/members`,
  );
  person = members.body.members.find((m) => m.own && m.kind === 'person')!.id;
});

test('add without a date of birth yet: the Add card shows and asks for it', async () => {
  // Found here: GET /api/elric answers eligible:false until the 18+ check passed, and the room
  // shows the Add card only when eligible, so its date of birth dialog is unreachable: a new
  // owner sees no Add card at all until they find Account settings.
  test.fixme(
    true,
    'Open bug: no Add card before a date of birth (the in-room dialog is unreachable).',
  );
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('region', { name: 'Add Elric' })).toBeVisible();
});

test('B6 + add: date of birth in Account, then the Add card (with the AI notice) adds Elric', async () => {
  await page.goto('/settings/account');
  await page.getByLabel('Date of birth (for Elric, 18 or over)').fill('1990-05-17');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.goto(`/rooms/${roomId}`);
  const card = page.getByRole('region', { name: 'Add Elric' });
  await expect(card).toBeVisible();
  if (FIXED.B6) await expect(card).toContainText(ELRIC_AI_NOTICE);
  await card.getByRole('button', { name: 'Add Elric' }).click();
  await expect(card).toHaveCount(0);
  let found: string | undefined;
  await expect
    .poll(async () => {
      const members = await call<{
        members: Array<{ id: string; auto_reply: { provider: string } | null }>;
      }>(owner, 'GET', `/api/rooms/${roomId}/members`);
      found = members.body.members.find((m) => m.auto_reply?.provider === 'elric')?.id;
      return Boolean(found);
    })
    .toBe(true);
  elricId = found!;
});

test('B6: the AI notice on first meeting Elric in the room', async () => {
  test.fixme(!FIXED.B6, 'B6 fix (the AI notice in the room UI) is not in this checkout yet.');
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByText(ELRIC_AI_NOTICE).first()).toBeVisible();
});

test('B5: nobody posts as Elric (API 403, and Elric is not in the "Post as" picker)', async () => {
  const before = (await messages()).length;
  const refused = await say('I am Elric now', elricId);
  expect(refused.status, refused.text).toBe(403);
  expect((refused.body as { code?: string }).code).toBe('elric_posts_itself');
  expect((await messages()).length).toBe(before);
  // The picker lists the owner's own members (host agent, person) but never Elric.
  await page.goto(`/rooms/${roomId}`);
  const picker = page.locator('.rm-post-as select');
  if (await picker.count())
    await expect(picker.locator('option', { hasText: /^Elric$/ })).toHaveCount(0);
});

test('B5 gap: nobody creates a room task as Elric either', async () => {
  // Found in the #337 review: the room post refuses Elric as sender, but POST
  // /api/rooms/:room/tasks with agent_id = Elric still creates a task "by Elric" (201).
  test.fixme(true, 'Open: room tasks accept Elric as the acting agent (B5 follow-up).');
  const res = await call<{ code?: string }>(owner, 'POST', `/api/rooms/${roomId}/tasks`, {
    title: `As Elric ${run}`,
    agent_id: elricId,
    idempotency_key: randomUUID(),
  });
  expect(res.status, res.text).toBe(403);
  expect(await tasks()).not.toContain(`As Elric ${run}`);
});

test('B3: the owner sees Elric’s reply as Elric with the AI tag, never "(you)"', async () => {
  const posted = await say(`@Elric say hello (${run})`);
  expect(posted.status, posted.text).toBe(201);
  const reply = await waitForElricReply(posted.body.message.seq);
  // The API marks it as the owner's own (Elric belongs to the viewer); the UI must not.
  expect(reply.auto_reply?.provider).toBe('elric');
  test.fixme(!FIXED.B3, 'B3 fix (Elric replies render as Elric) is not in this checkout yet.');
  await page.goto(`/rooms/${roomId}`);
  const message = page.locator('.rm-message', { hasText: reply.text }).last();
  await expect(message).toBeVisible();
  await expect(message).not.toHaveClass(/\bown\b/);
  await expect(message.locator('.rm-byline')).toContainText('Elric');
  await expect(message.locator('.rm-byline')).not.toContainText('(you)');
  await expect(message.locator('.rm-badge-elric')).toHaveText('AI');
});

async function requestTask(title: string) {
  const posted = await say(`@Elric create a task: ${title}`);
  expect(posted.status, posted.text).toBe(201);
  const reply = await waitForElricReply(posted.body.message.seq);
  expect(reply.text).toBe('Waiting for your approval.');
  expect(reply.auto_reply?.pending_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(await tasks()).not.toContain(title);
  return reply;
}

test('B1: approve from the room card creates the task', async () => {
  test.fixme(!FIXED.B1, 'B1 fix (the in-room approval card) is not in this checkout yet.');
  const title = `Approved ${run}`;
  await requestTask(title);
  await page.goto(`/rooms/${roomId}`);
  const card = page.locator('.rm-approval-card', { hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(card).toContainText('Approved');
  await expect.poll(async () => (await tasks()).includes(title)).toBe(true);
});

test('B1: reject from the room card creates nothing', async () => {
  test.fixme(!FIXED.B1, 'B1 fix (the in-room approval card) is not in this checkout yet.');
  const title = `Rejected ${run}`;
  await requestTask(title);
  await page.goto(`/rooms/${roomId}`);
  const card = page.locator('.rm-approval-card', { hasText: title });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card).toContainText('Rejected');
  expect(await tasks()).not.toContain(title);
  const pending = await call<{ pending: unknown[] }>(owner, 'GET', '/api/elric/pending');
  expect(JSON.stringify(pending.body)).not.toContain(title);
});

test('B1 (server, today): the reply waits for approval; approve creates, reject does not', async () => {
  const approveTitle = `Server approved ${run}`;
  const approve = await requestTask(approveTitle);
  const list = await call<{ pending: Array<{ id: string; args_hash: string }> }>(
    owner,
    'GET',
    '/api/elric/pending',
  );
  const item = list.body.pending.find((p) => p.id === approve.auto_reply!.pending_id)!;
  expect(item).toBeTruthy();
  const ok = await call(owner, 'POST', `/api/elric/pending/${item.id}/approve`, {
    args_hash: item.args_hash,
  });
  expect(ok.status, ok.text).toBe(200);
  await expect.poll(async () => (await tasks()).includes(approveTitle)).toBe(true);

  const rejectTitle = `Server rejected ${run}`;
  const reject = await requestTask(rejectTitle);
  const no = await call(
    owner,
    'POST',
    `/api/elric/pending/${reject.auto_reply!.pending_id}/reject`,
    {},
  );
  expect(no.status, no.text).toBe(200);
  expect(await tasks()).not.toContain(rejectTitle);
});
