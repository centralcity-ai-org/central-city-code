import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import { MAX_ACTIVE_ASSISTANT_GRANTS } from '../server/assistant-access.js';
import { backupDatabase, restoreDatabase } from '../server/recovery.js';
import { ASSISTANT_SCOPES, type AssistantGrant, type AssistantScope } from '../shared/assistant.js';
import type { Agent, Job, Snapshot } from '../shared/types.js';

type App = Awaited<ReturnType<typeof createApp>>;
const now = 1_800_000_000_000;
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
const password = 'Synthetic assistant access password';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
function api(app: App, cookie: string, url: string, body?: unknown, method?: 'DELETE') {
  return app.inject({
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers: { ...headers, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
function tool(app: App, token: string, name: string, body: unknown = {}) {
  return app.inject({
    method: 'POST',
    url: `/api/assistant/tools/${name}`,
    headers: { ...headers, authorization: `Bearer ${token}` },
    payload: JSON.stringify(body),
  });
}
async function account(app: App, name = 'Assistant owner') {
  const res = await api(app, '', '/api/auth/register', { name, password });
  assert.equal(res.statusCode, 201, res.body);
  return `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
}
async function grant(
  app: App,
  cookie: string,
  scopes: readonly AssistantScope[] = ASSISTANT_SCOPES,
) {
  const res = await api(app, cookie, '/api/assistant-access', {
    label: 'Synthetic client',
    scopes,
    expiresInDays: 1,
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { grant: AssistantGrant; token: string };
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, clock = () => now) {
  const app = await createApp({ dataDir: ':memory:', now: clock, startWorkers: false });
  t.after(() => app.close());
  const cookie = await account(app);
  const access = await grant(app, cookie);
  await api(app, cookie, '/api/demo/start', {});
  await app.city.tick();
  const state = (await api(app, cookie, '/api/snapshot')).json() as Snapshot;
  return { app, cookie, access, state };
}
const agentInput = () => ({
  name: 'Delegated record',
  description: 'Synthetic only',
  capability: 'extract',
  mode: 'external',
  idempotencyKey: randomUUID(),
});
const jobInput = (state: Snapshot) => ({
  requesterId: state.agents[0]!.id,
  providerId: state.agents[1]!.id,
  input: 'Synthetic amount 42',
  idempotencyKey: randomUUID(),
});

test('a grant beyond the active bound retires the least recently used grant instead of refusing', async (t) => {
  let time = now;
  const f = await fixture(t, () => time);
  const issued = [f.access];
  while (issued.length < MAX_ACTIVE_ASSISTANT_GRANTS) {
    if (issued.length % 9 === 0) time += 61_000; // stay under the issuance rate limit
    issued.push(await grant(f.app, f.cookie, ['workspace:read']));
  }
  // The first grant was used most recently, so it is never the one retired.
  time += 61_000;
  assert.equal((await tool(f.app, f.access.token, 'city_workspace')).statusCode, 200);
  const newest = await grant(f.app, f.cookie, ['workspace:read']);
  const grants = (await api(f.app, f.cookie, '/api/assistant-access')).json()
    .grants as AssistantGrant[];
  const active = grants.filter((entry) => entry.revokedAt === null);
  assert.equal(active.length, MAX_ACTIVE_ASSISTANT_GRANTS);
  // Exactly one grant was retired: one of the unused grants issued in the first batch.
  const firstBatch = issued.slice(1, 9);
  const retired = firstBatch.filter((entry) =>
    grants.some((row) => row.id === entry.grant.id && row.revokedAt !== null),
  );
  assert.equal(retired.length, 1);
  assert.equal(grants.filter((row) => row.revokedAt !== null).length, 1);
  assert.ok(active.some((entry) => entry.id === f.access.grant.id));
  assert.ok(active.some((entry) => entry.id === newest.grant.id));
  // The retired grant stops working at once, exactly like a manual revoke.
  assert.equal((await tool(f.app, retired[0]!.token, 'city_workspace')).statusCode, 401);
  assert.equal((await tool(f.app, newest.token, 'city_workspace')).statusCode, 200);
  const events = (await api(f.app, f.cookie, '/api/snapshot')).json().events as {
    message: string;
  }[];
  assert.ok(events.some((entry) => entry.message.includes('to make room for a new connection')));
});

test('grant owner isolation, mandatory read scope, bounds, one-time secret and expiry', async (t) => {
  let time = now;
  const f = await fixture(t, () => time);
  const other = await account(f.app, 'Other assistant owner');
  assert.deepEqual((await api(f.app, other, '/api/assistant-access')).json(), { grants: [] });
  assert.equal(
    (await api(f.app, other, `/api/assistant-access/${f.access.grant.id}`, {}, 'DELETE'))
      .statusCode,
    404,
  );
  for (const values of [
    { scopes: ['agents:create'], expiresInDays: 1 },
    { scopes: ['workspace:read', 'credentials:read'], expiresInDays: 1 },
    { scopes: ['workspace:read'], expiresInDays: 2 },
    { scopes: ['workspace:read', 'workspace:read'], expiresInDays: 1 },
  ])
    assert.equal(
      (await api(f.app, f.cookie, '/api/assistant-access', { label: 'Invalid', ...values }))
        .statusCode,
      400,
    );
  for (let i = 0; i < 4; i++) await grant(f.app, f.cookie, ['workspace:read']);
  // A sixth connection is no longer refused.
  await grant(f.app, f.cookie, ['workspace:read']);
  const list = await api(f.app, f.cookie, '/api/assistant-access');
  assert.equal(list.json().grants.length, 6);
  const stored = (
    await f.app.city.db.query<{ token_hash: string }>(
      'SELECT token_hash FROM assistant_grants WHERE id=$1',
      [f.access.grant.id],
    )
  ).rows[0]!;
  assert.equal(stored.token_hash, digest(f.access.token));
  for (const result of [
    list,
    await api(f.app, f.cookie, '/api/snapshot'),
    await api(f.app, f.cookie, '/api/workspace/export'),
    await tool(f.app, f.access.token, 'city_workspace'),
  ]) {
    assert.ok(!result.body.includes(f.access.token));
    assert.ok(!result.body.includes(stored.token_hash));
    assert.ok(!result.body.includes('token_hash'));
  }
  assert.equal((await api(f.app, '', '/api/assistant-access')).statusCode, 401);
  time += 86_400_000;
  assert.equal((await tool(f.app, f.access.token, 'city_workspace')).statusCode, 401);
});

test('tools require current bearer scope, request protection, and never use owner-cookie fallback', async (t) => {
  const f = await fixture(t),
    read = await grant(f.app, f.cookie, ['workspace:read']);
  for (const name of ['city_create_agent', 'city_create_job', 'city_cancel_job'])
    assert.equal((await tool(f.app, read.token, name)).statusCode, 403);
  for (const name of ['city_accept_job', 'city_connect', 'city_rotate_credential', 'constructor'])
    assert.equal((await tool(f.app, f.access.token, name)).statusCode, 404);
  assert.equal(
    (await api(f.app, f.cookie, '/api/assistant/tools/city_workspace', {})).statusCode,
    401,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/assistant/tools/city_workspace',
        headers: { authorization: `Bearer ${read.token}` },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/assistant/tools/city_workspace',
        headers: {
          ...headers,
          authorization: `Bearer ${read.token}`,
          origin: 'https://evil.invalid',
        },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (await tool(f.app, read.token, 'city_workspace', { includeCredentials: true })).statusCode,
    400,
  );
  const workspace = (await tool(f.app, read.token, 'city_workspace')).json();
  assert.deepEqual(Object.keys(workspace).sort(), ['agents', 'connections', 'operator', 'paused']);
  assert.ok(
    workspace.agents.every((agent: object) => !('lastSequence' in agent) && !('demoKey' in agent)),
  );
  const use = (await api(f.app, f.cookie, '/api/assistant-access'))
    .json()
    .grants.find((entry: AssistantGrant) => entry.id === read.grant.id);
  assert.equal(use.lastUsedAt, new Date(now).toISOString());
  const revoked = await api(
    f.app,
    f.cookie,
    `/api/assistant-access/${read.grant.id}`,
    {},
    'DELETE',
  );
  assert.equal(revoked.statusCode, 200);
  assert.equal((await tool(f.app, read.token, 'city_workspace')).statusCode, 401);
});

test('delegated registration is idempotent, scoped to its grant, paused safely, and issues no runtime authority', async (t) => {
  const f = await fixture(t),
    input = agentInput();
  const first = await tool(f.app, f.access.token, 'city_create_agent', input);
  assert.equal(first.statusCode, 200, first.body);
  const created = first.json() as {
    agent: Agent;
    runtimeSetupRequired: boolean;
    connectionRequired: boolean;
  };
  assert.equal(created.runtimeSetupRequired, true);
  assert.equal(created.connectionRequired, true);
  assert.equal(created.agent.status, 'offline');
  assert.ok(!first.body.includes('token'));
  assert.equal(
    (await f.app.city.db.query('SELECT * FROM credentials WHERE agent_id=$1', [created.agent.id]))
      .rows.length,
    0,
  );
  assert.equal(
    (await tool(f.app, f.access.token, 'city_create_agent', input)).json().agent.id,
    created.agent.id,
  );
  assert.equal(
    (await tool(f.app, f.access.token, 'city_create_agent', { ...input, name: 'Changed' }))
      .statusCode,
    409,
  );
  const secondGrant = await grant(f.app, f.cookie);
  assert.notEqual(
    (await tool(f.app, secondGrant.token, 'city_create_agent', input)).json().agent.id,
    created.agent.id,
  );
  const hosted = await tool(f.app, f.access.token, 'city_create_agent', {
    ...agentInput(),
    mode: 'hosted',
  });
  assert.equal(hosted.json().agent.isDemo, true);
  assert.equal(hosted.json().runtimeSetupRequired, false);
  await api(f.app, f.cookie, '/api/workspace/pause', { paused: true });
  assert.equal(
    (await tool(f.app, f.access.token, 'city_create_agent', agentInput())).statusCode,
    409,
  );
  await api(f.app, f.cookie, '/api/workspace/pause', { paused: false });
  const rotated = await api(
    f.app,
    f.cookie,
    `/api/agents/${created.agent.id}/rotate-credential`,
    {},
  );
  assert.equal(rotated.statusCode, 200);
  assert.ok(rotated.json().token);
});

test('delegated jobs preserve direction, admission limits, hosted-only providers, owner isolation and cancellation', async (t) => {
  const f = await fixture(t),
    input = jobInput(f.state);
  const first = await tool(f.app, f.access.token, 'city_create_job', input);
  assert.equal(first.statusCode, 200, first.body);
  const job = first.json().job as Job;
  assert.equal(job.costCents, 0);
  assert.equal(
    (
      await api(f.app, f.cookie, '/api/jobs', {
        ...input,
        idempotencyKey: `assistant:${f.access.grant.id}:${digest(input.idempotencyKey)}`,
      })
    ).statusCode,
    400,
  );
  await api(f.app, f.cookie, '/api/workspace/pause', { paused: true });
  assert.equal((await tool(f.app, f.access.token, 'city_create_job', input)).json().job.id, job.id);
  assert.equal(
    (
      await tool(f.app, f.access.token, 'city_create_job', {
        ...input,
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
    409,
  );
  await api(f.app, f.cookie, '/api/workspace/pause', { paused: false });
  assert.equal((await tool(f.app, f.access.token, 'city_create_job', input)).json().job.id, job.id);
  assert.equal(
    (await tool(f.app, f.access.token, 'city_create_job', { ...input, input: 'Changed' }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await tool(f.app, f.access.token, 'city_create_job', {
        ...input,
        idempotencyKey: randomUUID(),
        requesterId: input.providerId,
        providerId: input.requesterId,
      })
    ).statusCode,
    403,
  );
  const second = await tool(f.app, f.access.token, 'city_create_job', {
    ...input,
    idempotencyKey: randomUUID(),
  });
  assert.equal(second.statusCode, 200);
  assert.equal(
    (
      await tool(f.app, f.access.token, 'city_create_job', {
        ...input,
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
    409,
  );
  const other = await account(f.app, 'Other job owner'),
    otherGrant = await grant(f.app, other);
  for (const name of ['city_get_job', 'city_cancel_job'])
    assert.equal((await tool(f.app, otherGrant.token, name, { id: job.id })).statusCode, 404);
  assert.equal((await tool(f.app, otherGrant.token, 'city_create_job', input)).statusCode, 404);
  assert.equal(
    (await tool(f.app, f.access.token, 'city_cancel_job', { id: job.id })).statusCode,
    200,
  );
  assert.equal(
    (await tool(f.app, f.access.token, 'city_get_job', { id: job.id })).json().job.status,
    'canceled',
  );
  const connection = f.state.connections.find(
    (item) => item.fromAgentId === input.requesterId && item.toAgentId === input.providerId,
  )!;
  await api(f.app, f.cookie, `/api/connections/${connection.id}`, {}, 'DELETE');
  assert.equal((await tool(f.app, f.access.token, 'city_create_job', input)).statusCode, 403);
  const external = (
    await api(f.app, f.cookie, '/api/agents', {
      name: 'External provider',
      mode: 'external',
      capability: 'extract',
    })
  ).json();
  await api(f.app, f.cookie, '/api/connections', {
    fromAgentId: input.requesterId,
    toAgentId: external.agent.id,
  });
  assert.equal(
    (
      await tool(f.app, f.access.token, 'city_create_job', {
        ...input,
        providerId: external.agent.id,
        idempotencyKey: randomUUID(),
      })
    ).statusCode,
    403,
  );
});

test('cancellation synchronizes linked workflows and rate limits are per grant', async (t) => {
  const f = await fixture(t);
  await api(f.app, f.cookie, '/api/connections', {
    fromAgentId: f.state.agents[1]!.id,
    toAgentId: f.state.agents[0]!.id,
  });
  await api(f.app, f.cookie, '/api/connections', {
    fromAgentId: f.state.agents[0]!.id,
    toAgentId: f.state.agents[2]!.id,
  });
  const workflow = await api(f.app, f.cookie, '/api/workflows', {
    requesterId: f.state.agents[1]!.id,
    researcherId: f.state.agents[0]!.id,
    reviewerId: f.state.agents[2]!.id,
    source: 'Synthetic source',
    idempotencyKey: randomUUID(),
  });
  assert.equal(workflow.statusCode, 201, workflow.body);
  const id = workflow.json().workflow.briefJobId;
  assert.equal((await tool(f.app, f.access.token, 'city_cancel_job', { id })).statusCode, 200);
  assert.equal(
    (await api(f.app, f.cookie, '/api/snapshot')).json().workflows[0].status,
    'canceled',
  );
  const limited = await grant(f.app, f.cookie, ['workspace:read']);
  for (let i = 0; i < 120; i++)
    assert.equal((await tool(f.app, limited.token, 'city_workspace')).statusCode, 200);
  assert.equal((await tool(f.app, limited.token, 'city_workspace')).statusCode, 429);
  assert.equal((await tool(f.app, f.access.token, 'city_workspace')).statusCode, 200);
});

test('revocation, scope loss and expiry between bearer lookup and transaction deny stale actions', async (t) => {
  const f = await fixture(t);
  for (const change of ['revoke', 'scope', 'expire'] as const) {
    const access = await grant(f.app, f.cookie);
    let observed!: () => void, release!: () => void;
    const arrived = new Promise<void>((done) => {
      observed = done;
    });
    const resume = new Promise<void>((done) => {
      release = done;
    });
    t.after(release);
    const original = f.app.city.db.query.bind(f.app.city.db);
    let armed = true;
    const mock = t.mock.method(
      f.app.city.db,
      'query',
      async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (
          armed &&
          args[0].startsWith('SELECT id,operator_id FROM assistant_grants WHERE token_hash=')
        ) {
          armed = false;
          observed();
          await resume;
        }
        return result;
      },
    );
    const pending = Promise.resolve(tool(f.app, access.token, 'city_create_agent', agentInput()));
    await arrived;
    if (change === 'revoke')
      await api(f.app, f.cookie, `/api/assistant-access/${access.grant.id}`, {}, 'DELETE');
    else if (change === 'scope')
      await f.app.city.db.query('UPDATE assistant_grants SET scopes=$2::jsonb WHERE id=$1', [
        access.grant.id,
        JSON.stringify(['workspace:read']),
      ]);
    else
      await f.app.city.db.query('UPDATE assistant_grants SET expires_at=$2 WHERE id=$1', [
        access.grant.id,
        now,
      ]);
    release();
    assert.equal((await pending).statusCode, change === 'scope' ? 403 : 401);
    mock.mock.restore();
  }
  assert.equal((await api(f.app, f.cookie, '/api/snapshot')).json().agents.length, 3);
});

test('grant and retry survive restart but offline recovery excludes assistant authority', async () => {
  const base = resolve(tmpdir()),
    root = await mkdtemp(join(base, 'city-assistant-'));
  let app: App | undefined;
  try {
    const source = join(root, 'source'),
      backup = join(root, 'backup.json'),
      destination = join(root, 'restored');
    app = await createApp({ dataDir: source, now: () => now, startWorkers: false });
    const cookie = await account(app),
      access = await grant(app, cookie),
      input = agentInput();
    const created = (await tool(app, access.token, 'city_create_agent', input)).json().agent;
    await app.close();
    app = undefined;
    app = await createApp({ dataDir: source, now: () => now, startWorkers: false });
    assert.equal(
      (await tool(app, access.token, 'city_create_agent', input)).json().agent.id,
      created.id,
    );
    await app.close();
    app = undefined;
    await backupDatabase(source, backup);
    const saved = await readFile(backup, 'utf8');
    assert.ok(!saved.includes(access.token));
    assert.ok(!saved.includes(digest(access.token)));
    assert.ok(!saved.includes('assistant_grants'));
    await restoreDatabase(backup, destination);
    app = await createApp({ dataDir: destination, now: () => now, startWorkers: false });
    assert.equal((await tool(app, access.token, 'city_workspace')).statusCode, 401);
    assert.equal((await app.city.db.query('SELECT * FROM assistant_grants')).rows.length, 0);
    assert.equal((await app.city.db.query('SELECT * FROM assistant_receipts')).rows.length, 0);
    const login = await api(app, '', '/api/auth/login', { name: 'Assistant owner', password });
    const restoredCookie = `cc_session=${login.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
    assert.deepEqual((await api(app, restoredCookie, '/api/assistant-access')).json(), {
      grants: [],
    });
  } finally {
    await app?.close();
    assert.ok(resolve(root).startsWith(`${base}${sep}`));
    await rm(root, { recursive: true, force: true });
  }
});
