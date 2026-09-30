import { randomUUID } from 'node:crypto';
import { test, expect, type APIRequestContext } from '@playwright/test';
import type { Snapshot } from '../shared/types.js';

const password = 'Local-test-only-passphrase-2026';

async function aiWorkspace(request: APIRequestContext, name: string) {
  const created = await request.post('/api/public/workspaces', {
    headers: { 'content-type': 'application/json' },
    data: { name, idempotency_key: randomUUID() },
  });
  expect(created.status()).toBe(201);
  return (await created.json()) as {
    workspace_id: string;
    workspace_key: string;
    claim_token: string;
    claim_url: string;
  };
}
async function tool(request: APIRequestContext, key: string, name: string, args: unknown) {
  const res = await request.post(`/api/assistant/tools/${name}`, {
    headers: {
      'content-type': 'application/json',
      'x-city-request': '1',
      authorization: `Bearer ${key}`,
    },
    data: args,
  });
  expect(res.status(), await res.text()).toBe(200);
  return res.json();
}

test('a person claims an AI-owned workspace and approves a cross-owner request', async ({
  page,
}) => {
  // Two AIs, no humans: each creates its own workspace and a hosted agent with its key.
  const lab = await aiWorkspace(page.request, 'Parity Lab');
  const peer = await aiWorkspace(page.request, 'Peer Lab');
  const scout = (
    await tool(page.request, lab.workspace_key, 'city_create_agent', {
      name: 'Scout',
      capability: 'research',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const bravo = (
    await tool(page.request, peer.workspace_key, 'city_create_agent', {
      name: 'Bravo',
      capability: 'verify',
      mode: 'hosted',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  // The lab's AI hands the peer a single-use invite for Scout; the peer requests with it.
  const invite = await tool(page.request, lab.workspace_key, 'city_create_invite', {
    agent_id: scout,
  });
  await tool(page.request, peer.workspace_key, 'city_request_connection', {
    from_agent_id: bravo,
    invite_token: invite.invite_token,
    note: 'Synthetic request from another AI workspace.',
    idempotency_key: randomUUID(),
  });
  expect(new URL(lab.claim_url).hash).toBe(`#claim=${lab.claim_token}`);

  // A person signs up and claims the AI workspace from its claim link.
  await page.goto('/#signin');
  if (await page.getByRole('button', { name: 'Create an account', exact: true }).isVisible())
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
  await page.getByLabel('Account name').fill('Parity-Person');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // A new account lands on the Overview.
  await expect(page.getByRole('heading', { name: 'Everything, at a glance.' })).toBeVisible();
  await page.goto(`/#claim=${lab.claim_token}`);
  await page.reload();
  const input = page.getByLabel('Claim agents your AI created');
  await expect(input).toHaveValue(lab.claim_token);
  // Before claiming, the person sees which AI keys keep their access.
  await page.getByRole('button', { name: 'Claim', exact: true }).click();
  await expect(page.getByText('These AIs keep their access after you claim it.')).toBeVisible();
  await expect(page.getByText('initial key (main key)')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm claim', exact: true }).click();
  await expect(page.getByText('AI workspace claimed. You now co-own it')).toBeVisible();

  // The AI workspace appears in the switcher; the person acts in it as co-owner.
  const switcher = page.getByLabel('Switch workspace');
  await switcher.selectOption({ label: 'Parity Lab (AI workspace)' });
  await expect(page.getByText('AI workspace · you co-own it')).toBeVisible();
  await page.getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(page.getByText('Scout').first()).toBeVisible();

  // The incoming request is clearly labelled as from another person; the person approves it.
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Connections with other people' });
  await expect(panel.getByText('Bravo · Peer Lab')).toBeVisible();
  await expect(panel.getByText('Another person', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Approve connection request from Bravo' }).click();
  await expect(panel.getByText('Connection approved.')).toBeVisible();
  await expect(panel.getByText('Connected')).toBeVisible();

  // The peer AI can now message Scout; the co-owner sees it in the AI workspace.
  await tool(page.request, peer.workspace_key, 'city_send_message', {
    from_agent_id: bravo,
    to_agent_id: scout,
    text: 'Synthetic hello across workspaces.',
    idempotency_key: randomUUID(),
  });
  const state = (await (
    await page.request.get('/api/snapshot', { headers: { 'x-city-workspace': lab.workspace_id } })
  ).json()) as Snapshot;
  expect(state.operator.id).toBe(lab.workspace_id);
  expect(state.events.some((item) => item.type === 'connection.cross_approved')).toBe(true);
  // The external message is marked with the sending owner's label in Messages.
  await switcher.selectOption({ label: 'Parity Lab (AI workspace)' });
  await page.getByRole('button', { name: 'Messages', exact: true }).click();
  await expect(page.getByText('External · Peer Lab').first()).toBeVisible();

  // The co-owner's own workspace is untouched and still selectable.
  await switcher.selectOption({ label: 'Parity-Person (yours)' });
  await expect(page.getByText('Private workspace', { exact: true })).toBeVisible();
});
