import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.js';
import { exportWorkspace } from '../server/export.js';
import { emptyWorkspace, stopJob, type StoredJob } from '../server/model.js';

test('portable export includes all retained history and excludes storage authority fields', () => {
  const workspace = emptyWorkspace();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  workspace.agents.push({
    id: 'agent',
    name: 'Agent',
    description: '',
    capability: 'extract',
    mode: 'external',
    isDemo: false,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    revokedAt: null,
    lastSequence: 9,
    announcedOnline: true,
    demoKey: 'private-demo-reference',
  });
  workspace.jobs = Array.from({ length: 60 }, (_, i): StoredJob => ({
    id: `job-${i}`,
    requesterId: 'agent',
    providerId: 'agent',
    capability: 'extract',
    input: `Source ${i}`,
    output: { result: i },
    status: 'completed',
    acceptance: 'accepted',
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: timestamp,
    acceptedAt: timestamp,
    costCents: 0,
    error: null,
    isDemo: true,
    idempotencyKey: 'private-deduplication-key',
    requestHash: 'private-request-hash',
    attempts: 1,
    leaseHash: 'private-lease-hash',
    leaseExpiresAt: null,
    outputHash: 'private-output-hash',
  }));
  workspace.events = Array.from({ length: 110 }, (_, i) => ({
    id: `event-${i}`,
    type: 'job.completed',
    message: `Finished ${i}`,
    agentId: 'agent',
    jobId: `job-${i % 60}`,
    createdAt: timestamp,
  }));
  // Future private columns must not silently escape through object spreads.
  Object.assign(workspace.agents[0]!, { privateCredential: 'future-private-agent-field' });
  Object.assign(workspace.jobs[0]!, { privateCredential: 'future-private-job-field' });
  const before = JSON.stringify(workspace);
  const result = exportWorkspace(workspace, { id: 'owner', name: 'Operator' }, now);
  assert.equal(result.jobs.length, 60);
  assert.equal(result.events.length, 110);
  assert.deepEqual(result.jobs.at(-1)?.output, { result: 59 });
  assert.equal(result.jobs[0]!.acceptance, 'accepted');
  assert.equal(result.purpose, 'portable-records-not-a-recovery-backup');
  assert.equal(JSON.stringify(result).includes('private-'), false);
  assert.equal(JSON.stringify(result).includes('privateCredential'), false);
  assert.equal(JSON.stringify(workspace), before);
});

test('workspace export requires an owner session and cannot select another owner', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  assert.equal((await app.inject('/api/workspace/export')).statusCode, 401);
  const accounts = [];
  for (const name of ['Export owner one', 'Export owner two']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'content-type': 'application/json', 'x-city-request': '1' },
      payload: { name, password: 'Synthetic-export-test-passphrase' },
    });
    assert.equal(response.statusCode, 201, response.body);
    accounts.push({
      operator: response.json().operator,
      cookie: `cc_session=${response.cookies[0]!.value}`,
    });
  }
  const first = accounts[0]!,
    second = accounts[1]!;
  const response = await app.inject({
    url: `/api/workspace/export?operatorId=${second.operator.id}`,
    headers: { cookie: first.cookie },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().operator.id, first.operator.id);
  assert.equal(response.body.includes(second.operator.name), false);
  assert.match(response.headers['cache-control'] as string, /no-store/);
  assert.match(response.headers['content-disposition'] as string, /attachment/);
  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: first.cookie, 'content-type': 'application/json', 'x-city-request': '1' },
    payload: {},
  });
  assert.equal(logout.statusCode, 200);
  assert.equal(
    (await app.inject({ url: '/api/workspace/export', headers: { cookie: first.cookie } }))
      .statusCode,
    401,
  );
});

test('canceling an active job records a stable terminal timestamp', () => {
  const workspace = emptyWorkspace();
  const job = { status: 'running', id: 'job', providerId: 'agent', completedAt: null } as StoredJob;
  stopJob(workspace, job, 1800000000000, 'Test cancellation');
  assert.equal(job.completedAt, new Date(1800000000000).toISOString());
  stopJob(workspace, job, 1800000001000, 'Repeated cancellation');
  assert.equal(job.completedAt, new Date(1800000000000).toISOString());
});
