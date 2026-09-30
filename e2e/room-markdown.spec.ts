import { test, expect, type Page } from '@playwright/test';

/*
 * Room messages as Markdown (docs/ROOMS.md). The server stamps
 * room_messages.format (migration 22): new posts are 'markdown' and that value decides; a message
 * without a format is plain text. There is no client-side switch.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const MESSAGE = [
  '## Plan',
  '',
  'Ship **today**, see [the docs](https://centralcity.ai/docs) and <b>raw</b> <img src=x onerror="window.__xss=1">.',
  '',
  '![tracker](https://tracker.example/pixel.png)',
  '',
  '[bad](javascript:window.__xss=2)',
  '',
  '- [x] parser',
  '- [ ] preview',
  '',
  '```ts',
  'const answer: number = 42;',
  '```',
].join('\n');

async function roomWithMessage(page: Page, text: string) {
  const headers = { 'x-city-request': '1' };
  const name = `md-${crypto.randomUUID().slice(0, 8)}`;
  expect(
    (
      await page.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } })
    ).status(),
  ).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers,
    data: { name: 'Writer', description: 'e2e', capability: 'research', mode: 'external' },
  });
  expect(agent.ok()).toBeTruthy();
  const agentId = (await agent.json()).agent.id as string;
  const room = await page.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name: 'Markdown room', idempotency_key: crypto.randomUUID() },
  });
  expect(room.ok(), await room.text()).toBeTruthy();
  const roomId = (await room.json()).room.id as string;
  const post = await page.request.post(`/api/rooms/${roomId}/messages`, {
    headers,
    data: { text, idempotency_key: crypto.randomUUID() },
  });
  expect(post.ok(), await post.text()).toBeTruthy();
  return roomId;
}

test('a room message renders as safe Markdown with highlighted code', async ({ page }) => {
  const images: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'image') images.push(request.url());
  });
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(worker.url()));
  const roomId = await roomWithMessage(page, MESSAGE);
  await page.goto(`/rooms/${roomId}`);
  const message = page.getByTestId('room-message').last().locator('.rm-bubble');
  await expect(message.getByRole('heading', { name: 'Plan' })).toBeVisible();
  await expect(message.locator('strong')).toHaveText('today');
  const docs = message.getByRole('link', { name: 'the docs' });
  await expect(docs).toHaveAttribute('href', 'https://centralcity.ai/docs');
  await expect(docs).toHaveAttribute('rel', 'noopener nofollow ugc noreferrer');
  await expect(docs).toHaveAttribute('target', '_blank');
  // Raw HTML is literal text; the Markdown image is a link and is never requested.
  await expect(message).toContainText('<b>raw</b>');
  await expect(message).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(message.locator('img, b, script')).toHaveCount(0);
  await expect(message.getByRole('link', { name: 'Image: tracker' })).toHaveAttribute(
    'href',
    'https://tracker.example/pixel.png',
  );
  expect(images.filter((url) => url.includes('tracker.example'))).toEqual([]);
  // A javascript: link keeps its text, without a link.
  await expect(message.getByRole('link', { name: 'bad' })).toHaveCount(0);
  await expect(message).toContainText('bad');
  expect(await page.evaluate(() => (window as { __xss?: number }).__xss)).toBeUndefined();
  // Task list (display only) and the highlighted code block with Copy.
  await expect(message.getByRole('checkbox', { name: 'Done', exact: true })).toBeDisabled();
  const code = message.locator('.md-code');
  await expect(code.locator('.md-code-lang')).toHaveText('ts');
  await expect(code.locator('.hljs-keyword').first()).toHaveText('const');
  await expect(code.getByRole('button', { name: 'Copy code' })).toBeVisible();
  // The page never scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // The parse ran off the main thread.
  expect(workers.some((url) => /parse\.worker/.test(url))).toBe(true);
});

test('the server format decides: a new post renders as Markdown, and the composer has Preview', async ({
  page,
}) => {
  const roomId = await roomWithMessage(page, '**bold** `x`');
  await page.goto(`/rooms/${roomId}`);
  const message = page.getByTestId('room-message').last().locator('.rm-bubble');
  await expect(message.locator('strong')).toHaveText('bold');
  await expect(message.locator('code')).toHaveText('x');
  // New posts are Markdown, so the composer always offers Preview.
  await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible();
});

test('the composer Preview shows the draft rendered, and Edit returns to the text', async ({
  page,
}) => {
  const roomId = await roomWithMessage(page, 'hello');
  await page.goto(`/rooms/${roomId}`);
  const box = page.getByRole('textbox', { name: 'Message' });
  await box.fill('**bold** and `code`');
  await page.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('region', { name: 'Preview' });
  await expect(preview.locator('strong')).toHaveText('bold');
  await expect(box).toBeHidden();
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(box).toBeVisible();
  await expect(box).toHaveValue('**bold** and `code`');
});

test('a pathological message falls back to plain text and the room keeps working', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const roomId = await roomWithMessage(page, `${'>'.repeat(16_000)} x`);
  const headers = { 'x-city-request': '1' };
  for (const text of [
    `${'*'.repeat(8_000)}a${'*'.repeat(8_000)}`,
    '```a`\n' + '- '.repeat(8_000) + 'x',
    '**after** it',
  ])
    expect(
      (
        await page.request.post(`/api/rooms/${roomId}/messages`, {
          headers,
          data: { text, idempotency_key: crypto.randomUUID() },
        })
      ).ok(),
    ).toBeTruthy();
  await page.goto(`/rooms/${roomId}`);
  const bubbles = page.getByTestId('room-message').locator('.rm-bubble');
  await expect(bubbles.last().locator('strong')).toHaveText('after');
  await expect(bubbles.nth(0).locator('[data-markdown="plain"]')).toBeVisible();
  await expect(bubbles.nth(1).locator('[data-markdown="plain"]')).toBeVisible();
  await expect(bubbles.nth(2).locator('[data-markdown="plain"]')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('if the Markdown chunk fails to load, each message falls back to plain text', async ({
  page,
}) => {
  await page.route(/\/assets\/Markdown-[^/]+\.js$/, (route) => route.abort());
  const roomId = await roomWithMessage(page, '**still readable**');
  await page.goto(`/rooms/${roomId}`);
  const bubble = page.getByTestId('room-message').last().locator('.rm-bubble');
  await expect(bubble).toContainText('**still readable**');
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
});

/** Screenshots for the ops audit: run with MARKDOWN_SHOTS_DIR=<dir>. */
for (const width of [1440, 360])
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${width} ${scheme}`, async ({ page }) => {
      const dir = process.env.MARKDOWN_SHOTS_DIR;
      test.skip(!dir, 'Set MARKDOWN_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      const code = [
        'Here is the fix:',
        '',
        '```ts',
        'export function safeHref(url: string): string | null {',
        '  const parsed = new URL(url); // http(s) only',
        "  return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;",
        '}',
        '```',
        '',
        '| Step | Owner |',
        '|---|---|',
        '| Renderer | Vesta |',
        '',
        '> Images in Markdown are links, never loaded.',
      ].join('\n');
      const roomId = await roomWithMessage(page, `${MESSAGE}\n\n${code}`);
      await page.goto(`/rooms/${roomId}`);
      await expect(page.locator('.md-code .hljs-keyword').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `${dir}/markdown-${width}-${scheme}.png` });
    });
