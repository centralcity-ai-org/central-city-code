import { test, expect } from '@playwright/test';
import { e2eOrigin } from './port';

const origin = e2eOrigin();
const mcpUrl = `${origin}/mcp`;
const openUrl = `${origin}/mcp/open`;

/** VS Code: vscode:mcp/install?<encodeURIComponent(JSON.stringify({ name, type, url }))>. */
function expectVscodeLink(href: string | null, name: string, url: string) {
  expect(href).toBe(
    `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: 'http', url }))}`,
  );
  expect(JSON.parse(decodeURIComponent(href!.slice('vscode:mcp/install?'.length)))).toEqual({
    name,
    type: 'http',
    url,
  });
}

function expectCursorLink(href: string | null, name: string, url: string) {
  expect(href!.startsWith('cursor://anysphere.cursor-deeplink/mcp/install?')).toBe(true);
  const link = new URL(href!);
  expect(link.protocol).toBe('cursor:');
  expect(link.searchParams.get('name')).toBe(name);
  expect(link.searchParams.get('config')).toBe(
    Buffer.from(JSON.stringify({ url })).toString('base64'),
  );
  expect(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString())).toEqual({
    url,
  });
}

test('provider choices reveal only the selected setup and preserve keyboard access', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto('/#connect');
  await expect(page.getByRole('heading', { name: 'Which AI do you use?' })).toBeVisible();
  await expect(page.getByLabel('No-account MCP address')).not.toBeVisible();
  const cursor = page.getByRole('button', { name: /^Connect Cursor/ });
  await cursor.click();
  const dialog = page.getByRole('dialog');
  expectCursorLink(
    await dialog.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city-open',
    openUrl,
  );
  await dialog.getByRole('radio', { name: /Use my account/ }).check();
  expectCursorLink(
    await dialog.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(cursor).toBeFocused();
  await page.getByRole('button', { name: /^Connect VS Code/ }).click();
  expectVscodeLink(
    await dialog.getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'),
    'central-city-open',
    openUrl,
  );
  await dialog.getByRole('radio', { name: /Use my account/ }).check();
  expectVscodeLink(
    await dialog.getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Connect Codex/ }).click();
  await dialog.getByRole('button', { name: 'Copy connection link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(openUrl);
  await dialog.getByRole('radio', { name: /Use my account/ }).check();
  await dialog.getByRole('button', { name: 'Copy connection link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcpUrl);
  await dialog.getByRole('button', { name: 'What’s next' }).click();
  await expect(
    dialog.getByText('This page can’t see your AI app, so it never marks it as connected.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Bring Codex into a room' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Back to setup' }).click();
  await expect(dialog.getByRole('heading', { name: 'Connect Codex' })).toBeFocused();
  await dialog.getByRole('button', { name: 'What’s next' }).click();
  // The next step is a link to paste, never a prompt to type.
  await expect(dialog.getByRole('link', { name: 'Invite your AI' })).toHaveAttribute(
    'href',
    '/invite',
  );
  await expect(dialog.locator('pre')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Connect Claude Code/ }).click();
  await expect(dialog.getByLabel('Claude Code command')).toContainText(
    `claude mcp add --transport http central-city-open ${openUrl}`,
  );
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Connect ChatGPT/ }).click();
  await expect(dialog.getByText('This page is running on your computer.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'What’s next' })).not.toBeVisible();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 360, height: 780 });
  await page.getByRole('button', { name: /^Connect Codex/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('hosted setup provides a prefilled Claude link and honest ChatGPT limitations', async ({
  page,
}) => {
  // Proxy the local build to a public-looking origin without contacting a real provider.
  await page.route('https://centralcity.test/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }),
    });
  });
  await page.goto('https://centralcity.test/#connect');
  await page.getByRole('button', { name: /^Connect Claude Open/ }).click();
  const dialog = page.getByRole('dialog');
  const href = new URL(
    (await dialog.getByRole('link', { name: 'Open Claude to connect' }).getAttribute('href'))!,
  );
  expect(href.origin).toBe('https://claude.ai');
  expect(href.searchParams.get('modal')).toBe('add-custom-connector');
  expect(href.searchParams.get('connectorUrl')).toBe('https://centralcity.test/mcp/open');
  await dialog.getByRole('radio', { name: /Use my account/ }).check();
  expect(
    new URL(
      (await dialog.getByRole('link', { name: 'Open Claude to connect' }).getAttribute('href'))!,
    ).searchParams.get('connectorUrl'),
  ).toBe('https://centralcity.test/mcp');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Connect ChatGPT/ }).click();
  await expect(dialog.getByRole('link', { name: 'Open ChatGPT Plugins' })).toHaveAttribute(
    'href',
    'https://chatgpt.com/plugins',
  );
  await expect(dialog.getByRole('group', { name: 'ChatGPT connection link' })).toHaveText(
    'https://centralcity.test/mcp/open',
  );
  // ChatGPT's button is "Build MCP Apps"; a pasted address does nothing.
  await expect(dialog.getByText('Build MCP Apps', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('Create MCP App');
  await expect(
    dialog.getByText('Add this address as an app. Pasting it into a chat won’t connect.'),
  ).toBeVisible();
  await expect(dialog.getByText('No authentication', { exact: true })).toBeVisible();
  // The account connection (OAuth) works for ChatGPT since its client document is accepted.
  await dialog.getByRole('radio', { name: /Use my account/ }).check();
  await expect(dialog.getByRole('link', { name: 'Open ChatGPT Plugins' })).toBeVisible();
  await expect(dialog.getByRole('group', { name: 'ChatGPT connection link' })).toHaveText(
    'https://centralcity.test/mcp',
  );
  await expect(dialog.getByText('OAuth', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Developer mode', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'What’s next' })).toBeVisible();
  await page.keyboard.press('Escape');
  // Claude web: a three-step guide next to the prefilled link.
  await page.getByRole('button', { name: /^Connect Claude Open/ }).click();
  await expect(dialog.locator('.connect-instructions > li')).toHaveCount(3);
  await expect(dialog).toContainText('Claude Desktop');
});

test('one-click install links use the production signed-in, persistent address', async ({
  page,
}) => {
  await page.route('https://centralcity.test/**', async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      response: await route.fetch({ url: `${origin}${url.pathname}${url.search}` }),
    });
  });
  await page.goto('https://centralcity.test/#connect');
  const section = page.getByRole('region', { name: 'Install in one click' });
  // Any non-local origin (production or a preview) installs the production connection.
  const account = 'https://centralcity.ai/mcp';
  expectCursorLink(
    await section.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city',
    account,
  );
  expectVscodeLink(
    await section.getByRole('link', { name: 'Install in VS Code' }).getAttribute('href'),
    'central-city',
    account,
  );
  const claude = new URL(
    (await section
      .getByRole('link', { name: /Add to Claude and Claude Desktop/ })
      .getAttribute('href'))!,
  );
  expect(claude.origin).toBe('https://claude.ai');
  expect(claude.searchParams.get('modal')).toBe('add-custom-connector');
  expect(claude.searchParams.get('connectorUrl')).toBe(account);
  await page.setViewportSize({ width: 360, height: 780 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const link of await section.getByRole('link').all())
    expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
});

test('on a local server the one-click row offers only the local editors', async ({ page }) => {
  await page.goto('/#connect');
  const section = page.getByRole('region', { name: 'Install in one click' });
  expectCursorLink(
    await section.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'),
    'central-city',
    mcpUrl,
  );
  await expect(section.getByRole('link', { name: /Claude/ })).toHaveCount(0);
});

test('the developer REST example (in the docs) still creates a claimable team', async ({
  page,
}) => {
  // Developer setup lives in the docs; the Connect page links there (docs/COPY_GLOSSARY.md).
  await page.goto('/#connect');
  await expect(page.getByRole('link', { name: 'developer docs' })).toHaveAttribute(
    'href',
    '/docs/api',
  );
  await page.goto('/docs/api');
  const rest = await page.getByLabel('REST create request').textContent();
  const payload = JSON.parse(/-d '(.*)'/.exec(rest!)![1]!) as { idempotency_key: string };
  expect(payload.idempotency_key).toBe('<a fresh random UUID>');
  payload.idempotency_key = crypto.randomUUID();
  const created = await page.request.post('/api/public/agents', { data: payload });
  expect(created.status()).toBe(201);
  expect((await created.json()).claim.claim_url).toMatch(/#claim=ccclaim_/);
  await page.goto('/#connect');
  await page.getByRole('link', { name: 'Sign in to claim' }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
});

test('signed-in owners can open the claim box', async ({ page }) => {
  await page.goto('/#create');
  await page.getByLabel('Account name').fill('Browser-Connect');
  await page.getByLabel('Password', { exact: true }).fill('Local-test-only-passphrase-2026');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // A new account lands on the console Overview.
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Connect your AI', exact: true })
    .click();
  await expect(page.getByRole('button', { name: /^Connect ChatGPT/ })).toBeVisible();
  await page.getByRole('button', { name: 'Claim agents' }).click();
  await expect(page.getByLabel('Claim agents your AI created')).toBeVisible();
});
