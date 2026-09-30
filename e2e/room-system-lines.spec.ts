import { test, expect, type Browser } from '@playwright/test';

/*
 * Room system lines in the thread: server-written events (sender_kind 'system')
 * rendered as quiet, centred one-line notices without bylines, avatars or actions.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const headers = { 'x-city-request': '1' };

async function registerAccount(browser: Browser, label: string) {
  const context = await browser.newContext();
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const created = await context.request.post('/api/auth/register', {
    headers,
    data: { name, password: PASSWORD },
  });
  expect(created.status()).toBe(201);
  return { context, request: context.request, page: await context.newPage() };
}

function parseRgb(colorStr: string): [number, number, number] {
  const match = colorStr.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Cannot parse rgb from ${colorStr}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function luminance(r: number, g: number, b: number): number {
  const a = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
}

function contrastRatio(color1: string, color2: string): number {
  const rgb1 = parseRgb(color1);
  const rgb2 = parseRgb(color2);
  const lum1 = luminance(...rgb1);
  const lum2 = luminance(...rgb2);
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

test('system lines render as quiet centred notices without actions in light and dark', async ({
  browser,
}) => {
  const host = await registerAccount(browser, 'sys-host');
  const agentRes = await host.request.post('/api/agents', {
    headers,
    data: { name: 'Lead Agent', description: 'test', capability: 'research', mode: 'external' },
  });
  expect(agentRes.ok()).toBeTruthy();
  const agentId = (await agentRes.json()).agent.id as string;

  const roomRes = await host.request.post('/api/rooms', {
    headers,
    data: { agent_id: agentId, name: 'System line room', idempotency_key: crypto.randomUUID() },
  });
  expect(roomRes.status()).toBe(201);
  const room = (await roomRes.json()).room as { id: string };

  const systemText = 'Scout claimed task #1: *benchmark* [spec](https://example.com)';

  // Intercept messages request to inject system line between regular messages
  await host.page.route(`**/api/rooms/${room.id}/messages*`, async (route) => {
    const now = new Date();
    const t1 = new Date(now.getTime() - 60_000).toISOString();
    const t2 = new Date(now.getTime() - 30_000).toISOString();
    const t3 = now.toISOString();

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        room: {
          id: room.id,
          slug: 'system-line-room',
          name: 'System line room',
          topic: '',
          role: 'host',
          closed: false,
          read_only: false,
          history: 'full',
          member_count: 1,
          latest_seq: 3,
          created_at: t1,
        },
        messages: [
          {
            id: 'msg-1',
            seq: 1,
            origin: 'external',
            sender: 'Lead Agent',
            sender_agent_id: agentId,
            sender_owner_label: 'Your workspace',
            sender_kind: 'agent',
            format: 'plain',
            own: true,
            text: 'First regular message',
            parts: [{ type: 'text', text: 'First regular message' }],
            created_at: t1,
          },
          {
            id: 'msg-2-system',
            seq: 2,
            origin: 'external',
            sender: 'Central City',
            sender_agent_id: 'system',
            sender_owner_label: 'Central City',
            sender_kind: 'system',
            format: 'plain',
            own: false,
            text: systemText,
            parts: [{ type: 'text', text: systemText }],
            created_at: t2,
          },
          {
            id: 'msg-3',
            seq: 3,
            origin: 'external',
            sender: 'Lead Agent',
            sender_agent_id: agentId,
            sender_owner_label: 'Your workspace',
            sender_kind: 'agent',
            format: 'plain',
            own: true,
            text: 'Second regular message',
            parts: [{ type: 'text', text: 'Second regular message' }],
            created_at: t3,
          },
        ],
        latest_seq: 3,
        visible_from_seq: 1,
        next_since: 3,
        has_more: false,
      }),
    });
  });

  await host.page.goto(`/rooms/${room.id}`);
  await expect(host.page.locator('.rm-messages')).toBeVisible();

  // Verify the system line is present in the thread
  const systemLine = host.page.locator('[data-testid="room-system-line"]');
  await expect(systemLine).toBeVisible();
  await expect(systemLine).toHaveCount(1);
  await expect(systemLine).toHaveText(systemText);

  // Plain text verification: markdown syntax must remain raw plain text, not HTML tags
  await expect(systemLine.locator('a')).toHaveCount(0);
  await expect(systemLine.locator('em, strong, code')).toHaveCount(0);

  // No actions, no avatar, no byline
  await expect(systemLine.locator('button')).toHaveCount(0);
  await expect(systemLine.locator('.rm-byline')).toHaveCount(0);
  await expect(systemLine.locator('.rm-bubble')).toHaveCount(0);
  await expect(systemLine.locator('.badge-dot')).toHaveCount(0);

  // Positioned in order: between msg-1 and msg-3
  const items = host.page.locator('.rm-messages > li');
  const count = await items.count();
  let systemIndex = -1;
  let msg1Index = -1;
  let msg3Index = -1;
  for (let i = 0; i < count; i++) {
    const id = await items.nth(i).getAttribute('data-id');
    if (id === 'msg-1') msg1Index = i;
    if (id === 'msg-2-system') systemIndex = i;
    if (id === 'msg-3') msg3Index = i;
  }
  expect(msg1Index).toBeGreaterThanOrEqual(0);
  expect(systemIndex).toBeGreaterThan(msg1Index);
  expect(msg3Index).toBeGreaterThan(systemIndex);

  // Centred layout and quiet styling
  const style = await systemLine.evaluate((el) => {
    const comp = window.getComputedStyle(el);
    return {
      justifyContent: comp.justifyContent,
      textAlign: comp.textAlign,
      textColor: comp.color,
      bgColor: window.getComputedStyle(document.body).backgroundColor,
    };
  });
  expect(style.justifyContent).toBe('center');

  // WCAG AA contrast check in light mode (minimum 4.5:1)
  const lightContrast = contrastRatio(style.textColor, style.bgColor);
  expect(lightContrast).toBeGreaterThanOrEqual(4.5);

  // Switch to dark mode and verify contrast
  await host.page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  const darkStyle = await systemLine.evaluate((el) => {
    const comp = window.getComputedStyle(el);
    return {
      textColor: comp.color,
      bgColor: window.getComputedStyle(document.body).backgroundColor,
    };
  });
  const darkContrast = contrastRatio(darkStyle.textColor, darkStyle.bgColor);
  expect(darkContrast).toBeGreaterThanOrEqual(4.5);

  await host.context.close();
});
