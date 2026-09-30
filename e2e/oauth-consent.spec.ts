import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { e2eOrigin } from './port';

const CALLBACK = 'http://127.0.0.1:4799/callback';

test('owner signs in on the OAuth consent page, approves and returns to a loopback client', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const name = `OAuth-${randomUUID().slice(0, 8)}`;
  const password = `Synthetic-${randomUUID()}`;
  // Registration uses a separate request context so the browser has no owner session and the
  // consent page must perform its own login, as after a cross-site redirect.
  const owner = await request.post('/api/auth/register', {
    headers: { 'X-City-Request': '1' },
    data: { name, password },
  });
  expect(owner.status()).toBe(201);
  const client = await request.post('/oauth/register', {
    data: { client_name: 'Browser OAuth Client', redirect_uris: [CALLBACK] },
  });
  expect(client.status()).toBe(201);
  const clientId = (await client.json()).client_id as string;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'browser-state',
    scope: 'workspace:read agents:create',
    resource: `${e2eOrigin()}/mcp`,
  });

  // Stand in for the native client's loopback listener.
  await page.route(`${CALLBACK}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/plain', body: 'callback received' }),
  );
  await page.goto(`/oauth/authorize?${query}`);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Browser OAuth Client (returns to http://127.0.0.1:4799)',
  );
  await expect(page.getByText('Unverified client.')).toBeVisible();
  await page.getByLabel('Operator name').fill(name);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in and review' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('to access Central City?');
  await expect(page.getByText('Write access')).toBeVisible();
  await page.getByRole('checkbox', { name: /agents:create/ }).check();
  await page.getByRole('button', { name: 'Approve' }).click();
  await page.waitForURL((url) => url.href.startsWith(CALLBACK));
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('browser-state');
  expect(back.searchParams.get('iss')).toBe(e2eOrigin());
  const code = back.searchParams.get('code');
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const token = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: `${e2eOrigin()}/mcp`,
    },
  });
  expect(token.status()).toBe(200);
  const tokens = await token.json();
  expect(tokens.scope).toBe('workspace:read agents:create');
  expect(tokens.access_token).toMatch(/^cca_/);
  expect(errors).toEqual([]);
});
