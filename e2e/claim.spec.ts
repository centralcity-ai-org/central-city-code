import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { Snapshot } from '../shared/types.js';

const password = 'Local-test-only-passphrase-2026';

test('owner claims agents an anonymous AI client created, from a claim link', async ({ page }) => {
  // An AI client without an account creates an unclaimed agent (no cookies, no CSRF header).
  const created = await page.request.post('/api/public/agents', {
    headers: { 'content-type': 'application/json' },
    data: {
      template: 'template:research-analyst@1.0.0',
      idempotency_key: randomUUID(),
    },
  });
  expect(created.status()).toBe(201);
  const result = (await created.json()) as {
    agent: { id: string };
    claim: { claim_token: string; claim_url: string };
  };
  expect(new URL(result.claim.claim_url).hash).toBe(`#claim=${result.claim.claim_token}`);

  await page.goto('/#signin');
  // Sign-in mode, or registration on a fresh installation: wait for the form to settle first
  // instead of branching on an instant snapshot of the toggle.
  const createOne = page.getByRole('button', { name: 'Create an account', exact: true });
  const createWorkspace = page.getByRole('button', { name: 'Create account', exact: true });
  await expect(createOne.or(createWorkspace)).toBeVisible();
  if (await createOne.isVisible()) await createOne.click();
  await expect(createWorkspace).toBeVisible();
  await page.getByLabel('Account name').fill('Browser-Claimer');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await createWorkspace.click();
  // A new account lands on the Overview.
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();

  // Opening the claim link lands on Agents with the token prefilled and removed from the URL.
  await page.goto(`/#claim=${result.claim.claim_token}`);
  await page.reload();
  const input = page.getByLabel('Claim agents your AI created');
  await expect(input).toHaveValue(result.claim.claim_token);
  expect(new URL(page.url()).hash).toBe('');
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText('The agents are now in your workspace.')).toBeVisible();
  await expect(input).toHaveValue('');
  const state = (await (await page.request.get('/api/snapshot')).json()) as Snapshot;
  expect(state.agents.map((agent) => agent.id)).toEqual([result.agent.id]);
  expect(state.agents[0]!.createdBy?.kind).toBe('anonymous-client');

  // The token works once.
  // People paste the whole link; a used link is explained in words.
  await input.fill(result.claim.claim_url);
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(
    page.getByText('This claim link is invalid, has expired or was already used.'),
  ).toBeVisible();
});
