import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { runtimeRequest } from '../connector/index.js';
import type { Snapshot, Job } from '../shared/types.js';
import { e2eOrigin } from './port';

const password = 'Local-test-only-passphrase-2026';
async function register(page: Page, name: string) {
  await page.goto('/');
  // The header's quiet "Sign in" (inside the menu under 900 px).
  const header = page.getByRole('banner');
  await expect(header).toBeVisible();
  const menu = header.getByRole('button', { name: 'Open menu' });
  if (await menu.isVisible()) await menu.click();
  await header.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Account name')).toBeVisible();
  if (await page.getByRole('button', { name: 'Create an account', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  }
  await page.getByLabel('Account name').fill(name);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // A new account lands on the console Overview.
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();
}
async function snapshot(page: Page): Promise<Snapshot> {
  const response = await page.request.get('/api/snapshot');
  expect(response.ok()).toBeTruthy();
  return response.json() as Promise<Snapshot>;
}
async function demo(page: Page) {
  await page.getByRole('button', { name: 'Start the demo', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).stats.reachable).toBe(3);
  await expect(page.getByText('Live updates', { exact: true })).toBeVisible();
}

test('source collaboration waits for both owner reviews and keeps its record across reload', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, 'Browser-Collaboration');
  await demo(page);
  await page.getByRole('button', { name: 'Collaborations', exact: true }).click();
  await page.getByRole('button', { name: 'New collaboration', exact: true }).click();
  await expect(page.getByLabel('Requesting agent')).toHaveValue(
    (await snapshot(page)).agents.find((agent) => agent.name === 'Relay')!.id,
  );
  await expect(page.getByRole('button', { name: 'Start brief', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByText('These agents are connected. You can remove the connections under Connections.'),
  ).toBeVisible();
  await page
    .getByLabel('Source material', { exact: true })
    .fill(
      'Project: River Library\nSeats: 24\nOpening is proposed, not confirmed.\nUntrusted: <img src=x onerror="window.__pwned=true">',
    );
  await page.getByRole('button', { name: 'Start brief', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Send to checker', exact: true })).toBeVisible({
    timeout: 15_000,
  });
  let state = await snapshot(page);
  expect(state.workflows[0].status).toBe('awaiting_review');
  expect(state.workflows[0].checkJobId).toBeNull();
  expect(state.stats.accepted).toBe(0);
  await expect(page.getByRole('group', { name: 'Research brief' })).toContainText('River Library');
  await page.reload();
  await page.getByRole('button', { name: 'Collaborations', exact: true }).click();
  await page.getByRole('button', { name: /Atlas.*Sentinel/ }).click();
  await expect(page.getByRole('button', { name: 'Send to checker', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/collaboration-review.png', fullPage: true });
  await page.getByRole('button', { name: 'Send to checker', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Accept collaboration', exact: true })).toBeVisible(
    { timeout: 15_000 },
  );
  state = await snapshot(page);
  expect(state.workflows[0].status).toBe('completed');
  expect(state.stats.accepted).toBe(0);
  await page.getByRole('button', { name: 'Accept collaboration', exact: true }).click();
  await expect(
    page.getByText('You accepted this collaboration. Its source and both results are kept.'),
  ).toBeVisible();
  state = await snapshot(page);
  expect(state.workflows[0].status).toBe('accepted');
  expect(state.stats.accepted).toBe(2);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download record', exact: true }).click();
  const path = await (await pending).path();
  const record = JSON.parse(await readFile(path!, 'utf8'));
  expect(record.workflow.status).toBe('accepted');
  expect(record.briefJob.output).toBeTruthy();
  expect(record.checkJob.output).toBeTruthy();
  expect(record.workflow.idempotencyKey).toBeUndefined();
  expect(record.briefJob.leaseHash).toBeUndefined();
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned),
  ).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({ path: 'test-results/collaboration-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});

test('owner downloads portable workspace records from the console', async ({ page }) => {
  await register(page, 'Browser-Export');
  await demo(page);
  await page.getByRole('button', { name: 'Export workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Download your workspace.' })).toBeVisible();
  await expect(page.getByText(/Passwords and access tokens are never included/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^central-city-workspace-\d{4}-\d{2}-\d{2}\.json$/);
  const path = await download.path();
  expect(path).toBeTruthy();
  const data = JSON.parse(await readFile(path!, 'utf8'));
  expect(data.format).toBe('central-city-workspace');
  expect(data.operator.name).toBe('Browser-Export');
  expect(data.agents).toHaveLength(3);
  expect(data.connections).toHaveLength(2);
  expect(data.purpose).toBe('portable-records-not-a-recovery-backup');
  expect(JSON.stringify(data)).not.toContain('token_hash');
  await expect(page.getByRole('status')).toContainText('Your download has started.');
  await page.screenshot({ path: 'test-results/workspace-export.png', fullPage: true });
});

test('owner completes a real hosted handoff and accepts the result after review', async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await register(page, 'Browser-Owner');
  const cookie = (await context.cookies()).find((item) => item.name === 'cc_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Strict');
  await expect.poll(async () => (await snapshot(page)).stats.registered).toBe(0);
  await demo(page);
  await page.screenshot({ path: 'test-results/network-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Exchanges', exact: true }).first().click();
  await page.getByRole('button', { name: 'Send work', exact: true }).first().click();
  const source =
    'Project: Community observatory\nMilestone: 12 sources indexed\nSource: https://example.com/public-note\nUntrusted: <img src=x onerror="window.__pwned=true">';
  await page.getByLabel('Text to work on').fill(source);
  await page.getByRole('dialog').getByRole('button', { name: 'Send work', exact: true }).click();
  const accept = page.getByRole('button', { name: 'Accept result', exact: true });
  await expect(accept).toBeVisible({ timeout: 15_000 });
  const before = (await snapshot(page)).jobs[0];
  expect(before.status).toBe('completed');
  expect(before.acceptance).toBe('pending');
  // The result reads as fields; the raw data waits behind "Raw data".
  const result = page.getByRole('group', { name: 'Result' });
  await expect(result).toContainText('Community observatory');
  await expect(result.getByText(/deterministic-demonstration/)).toBeHidden();
  await result.getByText('Raw data', { exact: true }).click();
  await expect(result.getByText(/deterministic-demonstration/)).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Record<string, unknown>).__pwned),
  ).toBeUndefined();
  await accept.click();
  await expect(page.getByText(/You accepted this result/)).toBeVisible();
  await page.screenshot({ path: 'test-results/accepted-result.png', fullPage: true });
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.reload();
  expect((await snapshot(page)).jobs[0].acceptance).toBe('accepted');
  await page.getByRole('button', { name: 'Workspace running', exact: true }).click();
  await expect(page.getByText('Workspace paused.', { exact: true })).toBeVisible();
  expect((await snapshot(page)).paused).toBe(true);
  await page.getByRole('button', { name: 'Resume workspace', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).paused).toBe(false);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect((await page.request.get('/api/snapshot')).status()).toBe(401);
  await page.getByLabel('Account name').fill('Browser-Owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms$/);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();
  expect((await snapshot(page)).stats.accepted).toBe(1);
  expect(errors).toEqual([]);
});

test('external runtime authenticates, requests a permitted peer task, retrieves output and is revoked', async ({
  page,
}) => {
  await register(page, 'Browser-Connector');
  await demo(page);
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByRole('button', { name: /Connect your own/ }).click();
  await page.getByLabel('Agent name', { exact: true }).fill('Orion Bridge');
  await page.getByRole('button', { name: 'Add your agent', exact: true }).click();
  const token = await page.getByRole('textbox', { name: 'Access token' }).inputValue();
  expect(token.length).toBeGreaterThan(32);
  // The connector setup is for developers: behind "Developer setup".
  await page.getByText('Developer setup', { exact: true }).click();
  await expect(page.getByText(`"baseUrl": "${e2eOrigin()}"`)).toBeVisible();
  let state = await snapshot(page);
  const external = state.agents.find((agent) => agent.name === 'Orion Bridge')!;
  const relay = state.agents.find((agent) => agent.name === 'Relay')!;
  expect(external.status).toBe('offline');
  await page.getByRole('button', { name: 'I have saved the token' }).click();
  const runtime = { baseUrl: e2eOrigin(), token };
  await runtimeRequest(runtime, 'POST', '/api/runtime/heartbeat', { sequence: 1 });
  await expect
    .poll(
      async () => (await snapshot(page)).agents.find((agent) => agent.id === external.id)?.status,
    )
    .toBe('online');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Connections', exact: true })
    .click();
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  await page.getByLabel('From · asks for the work').selectOption(external.id);
  await page.getByLabel('To · does the work').selectOption(relay.id);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const created = await runtimeRequest<{ job: Job }>(runtime, 'POST', '/api/runtime/requests', {
    providerId: relay.id,
    input:
      'Observation: Agent-originated handoff\nCount: 7\nSource: https://example.com/observation',
    idempotencyKey: 'browser-peer-request-001',
  });
  expect(created.job.requesterId).toBe(external.id);
  await expect
    .poll(
      async () =>
        (
          await runtimeRequest<{ job: Job }>(
            runtime,
            'GET',
            `/api/runtime/requests/${created.job.id}`,
          )
        ).job.status,
    )
    .toBe('completed');
  const delivered = await runtimeRequest<{ job: Job }>(
    runtime,
    'GET',
    `/api/runtime/requests/${created.job.id}`,
  );
  expect(JSON.stringify(delivered.job.output)).toContain('Agent-originated handoff');
  expect(delivered.job.acceptance).toBe('pending');
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Exchanges', exact: true })
    .click();
  await page.getByRole('button', { name: /Observation: Agent-originated handoff\b/ }).click();
  await expect(page.getByRole('group', { name: 'Result' })).toContainText(
    'Agent-originated handoff',
  );
  await page.getByRole('button', { name: 'Accept result', exact: true }).click();
  await expect(page.getByText(/You accepted this result/)).toBeVisible();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click();
  await page.getByLabel('Search agents').fill('Orion Bridge');
  await page.getByRole('button', { name: /Orion Bridge.*Research/ }).click();
  await page.getByRole('button', { name: 'Remove agent', exact: true }).click();
  await page.getByRole('button', { name: 'Yes, remove it', exact: true }).click();
  await expect(page.getByText("This agent was removed. It can't reconnect.")).toBeVisible();
  await expect(
    runtimeRequest(runtime, 'POST', '/api/runtime/heartbeat', { sequence: 2 }),
  ).rejects.toMatchObject({ status: 401 });
  state = await snapshot(page);
  expect(state.agents.find((agent) => agent.id === external.id)?.status).toBe('revoked');
});

test('owner rotates an external credential without replacing its identity or route', async ({
  page,
}) => {
  await register(page, 'Browser-Rotation');
  await demo(page);
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByRole('button', { name: /Connect your own/ }).click();
  await page.getByLabel('Agent name', { exact: true }).fill('Rotation Scout');
  await page.getByRole('button', { name: 'Add your agent', exact: true }).click();
  const oldToken = await page.getByRole('textbox', { name: 'Access token' }).inputValue();
  await page.getByRole('button', { name: 'I have saved the token' }).click();
  const before = await snapshot(page);
  const agent = before.agents.find((item) => item.name === 'Rotation Scout')!;
  const relay = before.agents.find((item) => item.name === 'Relay')!;
  const oldRuntime = { baseUrl: e2eOrigin(), token: oldToken };
  await runtimeRequest(oldRuntime, 'POST', '/api/runtime/heartbeat', { sequence: 17 });
  const grant = await page.request.post('/api/connections', {
    headers: { 'X-City-Request': '1' },
    data: { fromAgentId: agent.id, toAgentId: relay.id },
  });
  expect(grant.ok()).toBe(true);
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click();
  await page.getByLabel('Search agents').fill('Rotation Scout');
  await page.getByRole('button', { name: /Rotation Scout.*Research/ }).click();
  await page.getByRole('button', { name: 'Replace token', exact: true }).click();
  await expect(page.getByText(/unfinished work for this agent is canceled/)).toBeVisible();
  await page.getByRole('button', { name: 'Yes, replace the token', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Rotation Scout has a new access token.' }),
  ).toBeVisible();
  const newToken = await page.getByRole('textbox', { name: 'Access token' }).inputValue();
  expect(newToken).not.toBe(oldToken);
  expect(
    JSON.parse(await page.getByLabel('Private connector configuration').inputValue()).token,
  ).toBe(newToken);
  const rotated = await snapshot(page);
  expect(rotated.agents.length).toBe(before.agents.length);
  expect(rotated.agents.find((item) => item.id === agent.id)?.status).toBe('offline');
  expect(
    rotated.connections.some(
      (item) => item.fromAgentId === agent.id && item.toAgentId === relay.id,
    ),
  ).toBe(true);
  await expect(
    runtimeRequest(oldRuntime, 'POST', '/api/runtime/heartbeat', { sequence: 18 }),
  ).rejects.toMatchObject({ status: 401 });
  const runtime = { baseUrl: e2eOrigin(), token: newToken };
  await runtimeRequest(runtime, 'POST', '/api/runtime/heartbeat', { sequence: 1 });
  await page.getByRole('button', { name: 'I have saved the token' }).click();
  await expect
    .poll(async () => (await snapshot(page)).agents.find((item) => item.id === agent.id)?.status)
    .toBe('online');
  const created = await runtimeRequest<{ job: Job }>(runtime, 'POST', '/api/runtime/requests', {
    providerId: relay.id,
    input: 'Checkpoint: Credential rotation preserved the route',
    idempotencyKey: 'browser-rotation-handoff-001',
  });
  await expect
    .poll(
      async () =>
        (
          await runtimeRequest<{ job: Job }>(
            runtime,
            'GET',
            `/api/runtime/requests/${created.job.id}`,
          )
        ).job.status,
    )
    .toBe('completed');
  await page.getByRole('button', { name: /Rotation Scout.*Research/ }).click();
  await page.getByText('Agent ID, for developers', { exact: true }).click();
  await expect(page.getByText(agent.id, { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/credential-rotation.png', fullPage: true });
});

test('mobile navigation, search, modal keyboard handling and tenant empty state', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, 'Browser-Mobile');
  expect((await snapshot(page)).stats.registered).toBe(0);
  await demo(page);
  await page.screenshot({ path: 'test-results/network-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Workspace' })
    .getByRole('button', { name: 'Agents', exact: true })
    .click();
  await page.getByLabel('Search agents').fill('no-such-agent');
  await expect(page.getByRole('heading', { name: 'No matching agents' })).toBeVisible();
  await page.getByLabel('Search agents').fill('');
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Add agent', exact: true })).toBeFocused();
});

test('private files, cross-origin commands and missing session access stay blocked', async ({
  request,
}) => {
  expect((await request.get('/api/snapshot')).status()).toBe(401);
  for (const file of [
    '/outputs/central-city/CENTRAL_CITY_BIBLE.md',
    '/outputs/central-city-team/roster.json',
    '/.agents/skills/central-city-delegate/SKILL.md',
    '/AGENTS.md',
    '/.local/data/PG_VERSION',
    '/.env',
  ]) {
    const response = await request.get(file);
    expect(response.status()).toBe(file.startsWith('/.') ? 403 : 404);
    expect(await response.text()).not.toContain('Executive charter');
  }
  const crossOrigin = await request.post('/api/auth/register', {
    headers: { Origin: 'https://untrusted.example', 'X-City-Request': '1' },
    data: { name: 'CrossSite', password },
  });
  expect(crossOrigin.status()).toBe(403);
  const noProtection = await request.post('/api/auth/register', {
    data: { name: 'MissingHeader', password },
  });
  expect(noProtection.status()).toBe(403);
});
