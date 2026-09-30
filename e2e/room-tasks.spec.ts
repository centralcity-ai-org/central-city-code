import { test, expect, type Browser, type Page } from '@playwright/test';

/*
 * The room's Tasks panel (src/rooms/TasksPanel.tsx) over the console REST routes (#163,
 * docs/ROOM_TASKS.md). The host adds a task and reviews what a member hands in: Accept, Send
 * back, Cancel. Members see the list read-only. Only each task's current state is shown.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function account(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, request: context.request, page: await context.newPage() };
}

/** A host with a room and a member (another account's agent) who joined it. */
async function roomWithMember(browser: Browser) {
  const host = await account(browser, 'task-host');
  const agent = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Host agent', description: 'e2e', capability: 'research', mode: 'external' },
  });
  const hostAgent = (await agent.json()).agent.id as string;
  const created = await host.request.post('/api/rooms', {
    headers,
    data: { agent_id: hostAgent, name: 'Launch plan', idempotency_key: crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const room = (await created.json()).room as { id: string };
  const minted = await host.request.post(`/api/rooms/${room.id}/link`, { headers, data: {} });
  const token = new URL((await minted.json()).link as string).hash.slice(1);
  const member = await account(browser, 'task-member');
  const joined = await member.request.post(`/api/rooms/${room.id}/join`, {
    headers,
    data: { token, create: { name: 'Scout' }, idempotency_key: crypto.randomUUID() },
  });
  expect(joined.ok(), await joined.text()).toBeTruthy();
  return { host, member, room };
}

/** The member takes a task and hands in a result (what their AI does over MCP). */
async function claimAndHandIn(
  member: { request: Page['request'] },
  roomId: string,
  taskId: string,
  ref: string,
) {
  const claim = await member.request.post(`/api/rooms/${roomId}/tasks/${taskId}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok(), await claim.text()).toBeTruthy();
  const { claim_token } = await claim.json();
  const result = await member.request.post(`/api/rooms/${roomId}/tasks/${taskId}/result`, {
    headers,
    data: { claim_token, evidence: { kind: 'proposal', ref, revision: 'r1' } },
  });
  expect(result.ok(), await result.text()).toBeTruthy();
}

async function openTasks(page: Page, roomId: string) {
  await page.goto(`/rooms/${roomId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Launch plan' })).toBeVisible();
  await page.getByRole('button', { name: /^Tasks/ }).click();
  const panel = page.getByRole('complementary', { name: 'Tasks' });
  await expect(panel).toBeVisible();
  return panel;
}

const taskItem = (panel: ReturnType<Page['getByRole']>, title: string) =>
  panel.getByRole('listitem').filter({ hasText: title });

test('the host adds a task, a member hands it in, the host sends it back and then accepts it', async ({
  browser,
}) => {
  const { host, member, room } = await roomWithMember(browser);
  const errors: string[] = [];
  host.page.on('pageerror', (error) => errors.push(error.message));
  const panel = await openTasks(host.page, room.id);
  await expect(panel.getByText('No tasks yet. Add the first one.')).toBeVisible();

  await panel.getByRole('button', { name: 'New task' }).click();
  await panel.getByLabel('Task', { exact: true }).fill('Draft the launch post');
  await panel.getByLabel('Details (optional)').fill('Two paragraphs, plain words.');
  await panel.getByRole('button', { name: 'Add task' }).click();
  const item = taskItem(panel, 'Draft the launch post');
  await expect(item).toContainText('T1');
  await expect(item).toContainText('Open');
  await expect(item).toContainText('Waiting for a member to take it.');
  await expect(host.page.getByRole('button', { name: 'Tasks, 1 to do' })).toBeVisible();

  // The member's AI takes it and hands in a result.
  const tasks = await (await host.request.get(`/api/rooms/${room.id}/tasks`)).json();
  const taskId = tasks.tasks[0].id as string;
  await claimAndHandIn(member, room.id, taskId, 'https://example.com/draft-1');
  await host.page.reload();
  const again = await openTasks(host.page, room.id);
  const review = taskItem(again, 'Draft the launch post');
  await expect(review).toContainText('Needs review');
  await expect(review).toContainText('Result: https://example.com/draft-1');

  // Send back: the task is open again (its current state only; no history lines here).
  await review.getByRole('button', { name: 'Send back' }).click();
  await expect(review).toContainText('Open');
  await expect(review.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  await claimAndHandIn(member, room.id, taskId, 'https://example.com/draft-2');
  await host.page.reload();
  const final = await openTasks(host.page, room.id);
  const done = taskItem(final, 'Draft the launch post');
  await done.getByRole('button', { name: 'Accept' }).click();
  await expect(done).toContainText('Accepted');
  await expect(done).toContainText('The host accepted the result.');
  await expect(done.getByRole('button', { name: 'Cancel task' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the host cancels a task; members see every task and its state, read-only', async ({
  browser,
}) => {
  const { host, member, room } = await roomWithMember(browser);
  for (const title of ['Collect sources', 'Check the numbers'])
    expect(
      (
        await host.request.post(`/api/rooms/${room.id}/tasks`, {
          headers,
          data: { title, idempotency_key: crypto.randomUUID() },
        })
      ).status(),
    ).toBe(201);
  const hostPanel = await openTasks(host.page, room.id);
  const cancel = taskItem(hostPanel, 'Check the numbers');
  await cancel.getByRole('button', { name: 'Cancel task' }).click();
  await cancel.getByRole('button', { name: 'Cancel task' }).click();
  await expect(cancel).toContainText('Cancelled');

  const list = await (await member.request.get(`/api/rooms/${room.id}/tasks`)).json();
  const collect = list.tasks.find((task: { title: string }) => task.title === 'Collect sources');
  const claim = await member.request.post(`/api/rooms/${room.id}/tasks/${collect.id}/claim`, {
    headers,
    data: { idempotency_key: crypto.randomUUID() },
  });
  expect(claim.ok()).toBeTruthy();

  const panel = await openTasks(member.page, room.id);
  await expect(panel.getByRole('button', { name: 'New task' })).toHaveCount(0);
  await expect(taskItem(panel, 'Collect sources')).toContainText('In progress');
  await expect(taskItem(panel, 'Collect sources')).toContainText('Scout is working on it');
  await expect(taskItem(panel, 'Check the numbers')).toContainText('Cancelled');
  await expect(panel.getByRole('button', { name: /Accept|Send back|Cancel task/ })).toHaveCount(0);
  // Plain words only.
  expect(await panel.innerText()).not.toMatch(/city_|[{}]|idempoten|claim_token|in_review/i);
});

for (const scheme of ['light', 'dark'] as const)
  test(`the Tasks panel fits 360 px (${scheme})`, async ({ browser }) => {
    const { host, room } = await roomWithMember(browser);
    await host.request.post(`/api/rooms/${room.id}/tasks`, {
      headers,
      data: {
        title: 'A long task title that has to wrap on a small phone screen without scrolling',
        idempotency_key: crypto.randomUUID(),
      },
    });
    await host.page.setViewportSize({ width: 360, height: 780 });
    await host.page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
    const panel = await openTasks(host.page, room.id);
    await expect(panel.getByRole('listitem')).toHaveCount(1);
    const box = (await panel.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(360 + 0.5);
    expect(
      await panel.evaluate(
        (element) =>
          [...element.querySelectorAll('*')].filter(
            (child) => child.getBoundingClientRect().right > innerWidth + 0.5,
          ).length,
      ),
    ).toBe(0);
    // Text and panel follow the theme (no hard-coded colours).
    const colours = await panel.evaluate((element) => ({
      panel: getComputedStyle(element).backgroundColor,
      text: getComputedStyle(element.querySelector('.rm-task-title')!).color,
    }));
    expect(colours.panel).not.toBe(colours.text);
  });
