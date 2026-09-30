import { test, expect, type Page, type Route } from '@playwright/test';

/*
 * Auto-reply settings UI against a mocked responder API: the #93 routes are not on main
 * yet, so /api/responder/* and /api/agents/:id/responder* are served by page.route with #93's
 * contract. The account, agent and console are real.
 */
const PASSWORD = 'Local-test-only-passphrase-2026';
const KEY = 'sk-ant-api03-e2e-test-value-not-a-real-key-000000';
const shotsDir = process.env.RESPONDER_SHOTS_DIR;

const MODELS = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    name: 'Claude Haiku 4.5 (retiring)',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    est_cost_per_reply_usd: 0.04,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    est_cost_per_reply_usd: 0.01,
    default: false,
  },
  {
    provider: 'openai',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    est_cost_per_reply_usd: 0.02,
    default: true,
  },
];

type Settings = Record<string, unknown> & { key: Record<string, unknown> | null };
function unset(agentId: string): Settings {
  return {
    agent_id: agentId,
    enabled: false,
    status: 'off',
    pause_reason: null,
    paused_until: null,
    provider: null,
    model: null,
    instructions: '',
    daily_reply_cap: 100,
    daily_spend_cap_usd: 2,
    key: null,
    replies_available: false,
  };
}

/** A stateful mock of #93's console API. `requests` records every call (bodies included). */
async function mockResponder(page: Page, agentId: string, initial?: Partial<Settings>) {
  let settings: Settings = { ...unset(agentId), ...initial };
  const requests: { method: string; path: string; body: unknown }[] = [];
  const json = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/responder/models**', (route) => json(route, 200, { models: MODELS }));
  await page.route(`**/api/agents/${agentId}/responder**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    requests.push({ method: request.method(), path, body });
    const now = '2026-09-28T09:00:00.000Z';
    if (path.endsWith('/responder/key')) {
      if (request.method() === 'DELETE') {
        settings = {
          ...settings,
          enabled: false,
          status: 'paused',
          pause_reason: 'key_removed',
          key: null,
        };
        return json(route, 200, { agent_id: agentId, removed: true });
      }
      if (body.key !== KEY)
        return json(route, 400, { error: 'server text is never shown', code: 'invalid_key' });
      const key = { provider: body.provider, added_at: now, validated_at: now, status: 'active' };
      settings = {
        ...settings,
        provider: body.provider,
        model: body.model,
        key,
        ...(['invalid_key', 'forbidden', 'key_removed'].includes(String(settings.pause_reason))
          ? { status: settings.enabled ? 'active' : 'off', pause_reason: null }
          : {}),
      };
      return json(route, 200, { key });
    }
    if (request.method() === 'PUT') {
      if (body.enabled && !settings.key)
        return json(route, 409, { error: 'x', code: 'key_required' });
      settings = { ...settings, ...body };
      if (body.enabled === true)
        settings = { ...settings, status: 'active', pause_reason: null, paused_until: null };
      if (body.enabled === false) settings = { ...settings, status: 'off' };
      return json(route, 200, settings);
    }
    return json(route, 200, settings);
  });
  return { requests };
}

async function openAgent(page: Page) {
  const headers = { 'x-city-request': '1' };
  const name = `ar-${crypto.randomUUID().slice(0, 8)}`;
  expect(
    (
      await page.request.post('/api/auth/register', { headers, data: { name, password: PASSWORD } })
    ).status(),
  ).toBe(201);
  const agent = await page.request.post('/api/agents', {
    headers,
    data: {
      name: 'Hazel',
      description: 'Research partner',
      capability: 'research',
      mode: 'external',
    },
  });
  expect(agent.ok()).toBeTruthy();
  return (await agent.json()).agent.id as string;
}

async function showAgent(page: Page) {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Workspace' });
  const menu = page.getByRole('button', { name: 'Open navigation' });
  const agents = nav.getByRole('button', { name: 'Agents', exact: true });
  await expect(menu.or(agents).first()).toBeVisible();
  if (await menu.isVisible()) await menu.click();
  await agents.click();
  await page.getByLabel('Search agents').fill('Hazel');
  await page.getByRole('button', { name: /Hazel/ }).first().click();
  return page.getByRole('region', { name: 'Auto-reply' });
}

test('hidden unless the server offers auto-reply', async ({ page }) => {
  test.skip(process.env.CITY_RESPONDER === '1', 'This server offers auto-reply.');
  await openAgent(page);
  // No mock: this server has no responder routes (404), so nothing renders.
  await showAgent(page);
  await expect(page.getByRole('button', { name: 'Remove agent' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Auto-reply' })).toHaveCount(0);
});

test('set up: provider, model, write-only key, limits, consent; errors are plain', async ({
  page,
}) => {
  const agentId = await openAgent(page);
  const mock = await mockResponder(page, agentId);
  const section = await showAgent(page);
  await expect(section.getByText('Reply automatically when @mentioned in a room.')).toBeVisible();
  await section.getByRole('button', { name: 'Set up' }).click();

  const sheet = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('radio', { name: 'Anthropic' })).toBeChecked();
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5');
  await expect(sheet.getByLabel('Model').locator('option')).toContainText([
    'Claude Haiku 4.5 (retiring) · about $0.01 a reply',
    'Claude Sonnet 5 · about $0.02 a reply',
    'Claude Opus 5.5 · about $0.04 a reply',
  ]);
  await expect(
    sheet.getByText(/sends that room's recent messages and your instructions to Anthropic/),
  ).toBeVisible();
  // Switching provider switches the models and the notice.
  await sheet.getByText('OpenAI', { exact: true }).click();
  await expect(sheet.getByLabel('Model')).toHaveValue('gpt-6-sol');
  await expect(sheet.getByText(/OpenAI bills you\./)).toBeVisible();
  await sheet.getByText('Anthropic', { exact: true }).click();

  // Empty key and bad limits are caught before any request.
  await sheet.getByText('Limits').click();
  await sheet.getByLabel('Replies a day, at most').fill('5000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText('Paste your Anthropic API key.')).toBeVisible();
  await expect(sheet.getByText('Enter a whole number from 1 to 1,000.')).toBeVisible();
  expect(mock.requests.filter((r) => r.method !== 'GET')).toEqual([]);
  await sheet.getByLabel('Replies a day, at most').fill('50');
  await sheet.getByLabel(/Stop after about/).fill('1.25');

  // A rejected key: the server's code becomes plain words on the key field.
  const keyField = sheet.getByLabel('Anthropic API key');
  await expect(keyField).toHaveAttribute('type', 'password');
  await keyField.fill('sk-ant-api03-wrong-key-wrong-key-00000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(
    sheet.getByText("Anthropic didn't accept this key. Check that you copied all of it."),
  ).toBeVisible();
  await expect(keyField).toHaveAttribute('aria-invalid', 'true');
  // A rejected key is cleared from the page.
  await expect(keyField).toHaveValue('');
  await expect(keyField).toHaveAttribute('autocomplete', 'new-password');
  await expect(keyField).toHaveAttribute('data-1p-ignore', 'true');
  await expect(sheet.getByText('server text is never shown')).toHaveCount(0);

  await keyField.fill(KEY);
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet).toBeHidden();
  const writes = mock.requests.filter((r) => r.method !== 'GET');
  expect(writes.at(-2)).toEqual({
    method: 'POST',
    path: `/api/agents/${agentId}/responder/key`,
    body: { provider: 'anthropic', model: 'claude-sonnet-5', key: KEY },
  });
  expect(writes.at(-1)).toEqual({
    method: 'PUT',
    path: `/api/agents/${agentId}/responder`,
    body: {
      model: 'claude-sonnet-5',
      instructions: '',
      daily_reply_cap: 50,
      daily_spend_cap_usd: 1.25,
      enabled: true,
    },
  });
  // On: the switch, the settings line, and the key only as "Key saved" with its dates.
  await expect(section.getByRole('switch', { name: 'Auto-reply' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(section).toContainText(
    'Anthropic · Claude Sonnet 5 · up to 50 replies a day · stops after about $1.25 a day',
  );
  await expect(section).toContainText('Key saved · added 28 Sep · checked 28 Sep');
  expect(await page.content()).not.toContain(KEY);
  if (shotsDir) await section.screenshot({ path: `${shotsDir}/section-on-1440-light.png` });

  // Off, then on again.
  await section.getByRole('switch', { name: 'Auto-reply' }).click();
  await expect(section.getByRole('switch', { name: 'Auto-reply' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await section.getByRole('switch', { name: 'Auto-reply' }).click();
  await expect(section.getByRole('switch', { name: 'Auto-reply' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Remove, with the provider named in the confirmation.
  await section.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(section.getByText(/also delete it at Anthropic/)).toBeVisible();
  await section.getByRole('button', { name: 'Remove key' }).click();
  await expect(section.getByText('Off: the key was removed.')).toBeVisible();
  await expect(section.getByRole('button', { name: 'Add a key' })).toBeVisible();
});

test('paused states read in plain words and offer the fix; Esc closes only the sheet', async ({
  page,
}) => {
  const agentId = await openAgent(page);
  const key = {
    provider: 'openai',
    added_at: '2026-09-27T09:00:00.000Z',
    validated_at: '2026-09-27T09:00:00.000Z',
    status: 'active',
  };
  const mock = await mockResponder(page, agentId, {
    enabled: true,
    status: 'paused',
    pause_reason: 'quota',
    provider: 'openai',
    model: 'gpt-6-luna',
    key,
  });
  const section = await showAgent(page);
  const paused = section.getByRole('status').filter({ hasText: 'Paused' });
  await expect(paused).toHaveText(/Paused: your OpenAI quota is used up\./);
  await expect(section).toContainText('OpenAI · GPT-6 Luna');
  if (shotsDir) await section.screenshot({ path: `${shotsDir}/section-paused-1440-light.png` });
  await section.getByRole('button', { name: 'Resume' }).click();
  await expect(section.getByRole('switch', { name: 'Auto-reply' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(mock.requests.at(-1)).toMatchObject({ method: 'PUT', body: { enabled: true } });

  // Settings sheet: no key field; Esc closes it and leaves the agent sheet open.
  await section.getByRole('button', { name: 'Settings' }).click();
  const sheet = page.getByRole('dialog', { name: 'Auto-reply settings' });
  await expect(sheet.getByLabel('Replies a day, at most')).toHaveValue('100');
  await expect(sheet.locator('input[type="password"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(section).toBeVisible();
});

/** Screenshots for a UX review: RESPONDER_SHOTS_DIR=<dir>. */
for (const width of [1440, 768, 360])
  for (const scheme of ['light', 'dark'] as const)
    test(`screenshot ${width} ${scheme}`, async ({ page }) => {
      test.skip(!shotsDir, 'Set RESPONDER_SHOTS_DIR to write screenshots.');
      await page.setViewportSize({ width, height: width === 360 ? 780 : 900 });
      await page.addInitScript((theme) => localStorage.setItem('cc-theme', theme), scheme);
      const agentId = await openAgent(page);
      await mockResponder(page, agentId, {
        enabled: true,
        status: 'active',
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        key: {
          provider: 'anthropic',
          added_at: '2026-09-27T09:00:00.000Z',
          validated_at: '2026-09-28T09:00:00.000Z',
          status: 'active',
        },
      });
      const section = await showAgent(page);
      await expect(section.getByRole('switch')).toBeVisible();
      await section.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({ path: `${shotsDir}/on-${width}-${scheme}.png` });
      await section.getByRole('button', { name: 'Replace' }).click();
      await page.getByRole('dialog', { name: 'Replace the key' }).waitFor();
      await page.screenshot({ path: `${shotsDir}/replace-key-${width}-${scheme}.png` });
      await page.keyboard.press('Escape');
      // The setup sheet, as a fresh agent would see it.
      await page.route(`**/api/agents/${agentId}/responder`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(unset(agentId)),
        }),
      );
      await page.getByRole('button', { name: 'Close dialog' }).click();
      await page.getByRole('button', { name: /Hazel/ }).first().click();
      await section.getByRole('button', { name: 'Set up' }).click();
      const sheet = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
      await sheet.getByText('Limits').click();
      await page.screenshot({ path: `${shotsDir}/setup-${width}-${scheme}.png`, fullPage: false });
    });

/**
 * The same UI against #93's real routes (run with CITY_RESPONDER=1). No provider is called: only
 * paths the server decides before any network request (format checks, key_required) are used.
 */
test('against the real responder API: models, settings, format errors, key required', async ({
  page,
}) => {
  test.skip(process.env.CITY_RESPONDER !== '1', 'Run with CITY_RESPONDER=1 for the real API.');
  const agentId = await openAgent(page);
  const models = await page.request.get('/api/responder/models');
  expect(models.ok()).toBeTruthy();
  const list = (await models.json()).models as { provider: string; id: string; default: boolean }[];
  expect(list.find((m) => m.provider === 'anthropic' && m.default)?.id).toBe('claude-sonnet-5');
  const settings = await page.request.get(`/api/agents/${agentId}/responder`);
  expect(Object.keys(await settings.json()).sort()).toEqual(
    [
      'agent_id',
      'daily_reply_cap',
      'daily_spend_cap_usd',
      'enabled',
      'instructions',
      'key',
      'model',
      'pause_reason',
      'paused_until',
      'provider',
      'replies_available',
      'status',
    ].sort(),
  );

  const section = await showAgent(page);
  await expect(section.getByRole('button', { name: 'Set up' })).toBeVisible();
  await section.getByRole('button', { name: 'Set up' }).click();
  const sheet = page.getByRole('dialog', { name: 'Set up auto-reply for Hazel' });
  await expect(sheet.getByLabel('Model')).toHaveValue('claude-sonnet-5');
  const key = sheet.getByLabel('Anthropic API key');
  // An admin key and a malformed key are refused by the server before any provider call.
  await key.fill('sk-ant-admin01-not-a-real-key-000000000000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText('Use a standard API key, not an admin key.')).toBeVisible();
  await key.fill('not-an-anthropic-key-0000000000000');
  await sheet.getByRole('button', { name: 'Turn on' }).click();
  await expect(sheet.getByText(/doesn’t look like an Anthropic API key/)).toBeVisible();
  await page.keyboard.press('Escape');
  // Turning on without a key: the server's key_required becomes plain words.
  const put = await page.request.put(`/api/agents/${agentId}/responder`, {
    headers: { 'x-city-request': '1' },
    data: { enabled: true },
  });
  expect(put.status()).toBe(409);
  expect((await put.json()).code).toBe('key_required');
});
