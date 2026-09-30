import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transaction as Tx } from '../server/database.js';
import { createApp } from '../server/app.js';

type App = Awaited<ReturnType<typeof createApp>>;
const now = 1_800_000_000_000;
const extension = 'urn:central-city:a2a:native-auth:1';
// Deliberately independent HTTP client: no connector, protocol parser or transport helper imports.
function sign(token: string, path: string, body: string) {
  const nonce = randomUUID();
  const digest = createHash('sha256').update(body).digest('hex');
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    'x-cc-timestamp': String(now),
    'x-cc-nonce': nonce,
    'x-cc-signature': createHmac('sha256', token)
      .update(`POST\n${path}\n${now}\n${nonce}\n${digest}`)
      .digest('hex'),
    'a2a-version': '1.0',
    'a2a-extensions': extension,
  };
}
async function http(base: string, path: string, body?: unknown, cookie = '', method?: string) {
  const response = await fetch(base + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json', 'x-city-request': '1', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
async function runtime(
  base: string,
  token: string,
  path: string,
  value: unknown,
  override: Record<string, string> = {},
) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const response = await fetch(base + path, {
    method: 'POST',
    body,
    headers: { ...sign(token, path, body), ...override },
  });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
const send = (messageId = randomUUID(), text = 'Invoice amount: 42') => ({
  jsonrpc: '2.0',
  id: randomUUID(),
  method: 'SendMessage',
  params: {
    message: { messageId, role: 'ROLE_USER', parts: [{ text }] },
    configuration: { returnImmediately: true },
  },
});
const taskRequest = (method: string, id: string) => ({
  jsonrpc: '2.0',
  id: randomUUID(),
  method,
  params: { id },
});
async function account(base: string, name: string) {
  const response = await http(base, '/api/auth/register', {
    name,
    password: 'Synthetic A2A password only',
  });
  assert.equal(response.status, 201);
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
async function register(base: string, cookie: string, name: string, mode = 'external') {
  const response = await http(base, '/api/agents', { name, mode, capability: 'extract' }, cookie);
  assert.equal(response.status, 201);
  return response.body;
}
async function connect(base: string, cookie: string, fromAgentId: string, toAgentId: string) {
  const response = await http(base, '/api/connections', { fromAgentId, toAgentId }, cookie);
  assert.equal(response.status, 201);
  return response.body.connection;
}
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }, dataDir = ':memory:') {
  const app = await createApp({ dataDir, now: () => now, startWorkers: false });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const cookie = await account(base, 'A2A owner');
  const requester = await register(base, cookie, 'Requester');
  const provider = await register(base, cookie, 'Provider', 'hosted');
  assert.equal(
    (await runtime(base, requester.token, '/api/runtime/heartbeat', { sequence: 0 })).status,
    200,
  );
  await app.city.tick();
  const grant = await connect(base, cookie, requester.agent.id, provider.agent.id);
  const path = `/api/runtime/a2a/${provider.agent.id}`;
  const rpc = (
    request: unknown,
    token = requester.token,
    endpoint = path,
    override: Record<string, string> = {},
  ) => runtime(base, token, endpoint, request, override);
  return { app, base, cookie, requester, provider, grant, path, rpc };
}

test('real HTTP A2A sends, durably deduplicates, completes, and keeps acceptance separate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'city-a2a-'));
  const f = await fixture(t, join(directory, 'data'));
  const message = send();
  const responses = await Promise.all([f.rpc(message), f.rpc({ ...message, id: 'retry' })]);
  assert.ok(responses.every((r) => r.status === 200 && r.body.result));
  const task = responses[0]!.body.result.task;
  assert.deepEqual(task, responses[1]!.body.result.task);
  assert.equal(task.status.state, 'TASK_STATE_SUBMITTED');
  assert.equal(responses[0]!.headers.get('a2a-version'), '1.0');
  assert.equal((await f.rpc(send(message.params.message.messageId, 'changed'))).status, 409);
  const changedConfiguration = structuredClone(message);
  Object.assign(changedConfiguration.params.configuration, { historyLength: 0 });
  assert.equal((await f.rpc(changedConfiguration)).status, 409);
  await f.app.city.tick();
  await f.app.city.tick();
  const done = await f.rpc(taskRequest('GetTask', task.id));
  assert.equal(done.body.result.status.state, 'TASK_STATE_COMPLETED');
  assert.ok(done.body.result.artifacts[0].parts[0].data);
  assert.equal((await f.rpc(taskRequest('CancelTask', task.id))).body.error.code, -32002);
  const snapshot = (await http(f.base, '/api/snapshot', undefined, f.cookie)).body;
  assert.equal(snapshot.jobs.length, 1);
  assert.equal(snapshot.jobs[0].acceptance, 'pending');
  for (const secret of [
    f.requester.agent.id,
    f.provider.agent.id,
    snapshot.jobs[0].id,
    f.requester.token,
  ])
    assert.ok(!JSON.stringify(done.body).includes(secret));
  await f.app.close();
  const reopened = await createApp({
    dataDir: join(directory, 'data'),
    now: () => now,
    startWorkers: false,
  });
  t.after(async () => {
    await reopened.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = await reopened.listen({ host: '127.0.0.1', port: 0 });
  const retry = await runtime(base, f.requester.token, f.path, message);
  assert.equal(retry.body.result.task.id, task.id);
  assert.equal(retry.body.result.task.status.state, 'TASK_STATE_COMPLETED');
});

test('HTTP task authority binds owner, requester, provider, grant and current credential', async (t) => {
  const f = await fixture(t);
  const message = send();
  const task = (await f.rpc(message)).body.result.task;
  const otherRequester = await register(f.base, f.cookie, 'Other requester');
  await connect(f.base, f.cookie, otherRequester.agent.id, f.provider.agent.id);
  const otherProvider = await register(f.base, f.cookie, 'Other provider', 'hosted');
  await connect(f.base, f.cookie, f.requester.agent.id, otherProvider.agent.id);
  const foreignCookie = await account(f.base, 'Foreign A2A owner');
  const foreignRequester = await register(f.base, foreignCookie, 'Foreign requester');
  for (const method of ['GetTask', 'CancelTask']) {
    assert.equal(
      (await f.rpc(taskRequest(method, task.id), otherRequester.token)).body.error.code,
      -32001,
    );
    assert.equal(
      (
        await f.rpc(
          taskRequest(method, task.id),
          f.requester.token,
          `/api/runtime/a2a/${otherProvider.agent.id}`,
        )
      ).body.error.code,
      -32001,
    );
    assert.equal((await f.rpc(taskRequest(method, task.id), foreignRequester.token)).status, 404);
  }
  assert.equal(
    (await f.rpc(send(), f.requester.token, `/api/runtime/a2a/${otherRequester.agent.id}`)).status,
    403,
  );
  const canceled = await f.rpc(taskRequest('CancelTask', task.id));
  assert.equal(canceled.body.result.status.state, 'TASK_STATE_CANCELED');
  assert.equal((await f.rpc(taskRequest('CancelTask', task.id))).body.error.code, -32002);
  await f.app.city.tick();
  assert.equal(
    (await f.rpc(taskRequest('GetTask', task.id))).body.result.status.state,
    'TASK_STATE_CANCELED',
  );
  const rotated = await http(
    f.base,
    `/api/agents/${f.requester.agent.id}/rotate-credential`,
    {},
    f.cookie,
  );
  for (const request of [
    message,
    taskRequest('GetTask', task.id),
    taskRequest('CancelTask', task.id),
  ])
    assert.equal((await f.rpc(request)).status, 401);
  assert.equal(
    (await f.rpc(taskRequest('GetTask', task.id), rotated.body.token)).body.result.id,
    task.id,
  );
  assert.equal(
    (await http(f.base, `/api/connections/${f.grant.id}`, undefined, f.cookie, 'DELETE')).status,
    200,
  );
  for (const request of [
    message,
    taskRequest('GetTask', task.id),
    taskRequest('CancelTask', task.id),
  ])
    assert.equal((await f.rpc(request, rotated.body.token)).status, 403);
  await http(f.base, `/api/agents/${f.requester.agent.id}/revoke`, {}, f.cookie);
  assert.equal((await f.rpc(message, rotated.body.token)).status, 401);
});

test('HTTP protocol and authentication bounds reject unsupported or unsigned requests', async (t) => {
  const f = await fixture(t);
  for (const version of ['', '0.3', '1.0.0', '2.0'])
    assert.equal(
      (await f.rpc(send(), undefined, undefined, { 'a2a-version': version })).body.error.code,
      -32009,
    );
  assert.equal(
    (await f.rpc(send(), undefined, undefined, { 'a2a-extensions': '' })).body.error.code,
    -32008,
  );
  assert.equal(
    (await f.rpc(send(), undefined, undefined, { 'x-cc-signature': '0'.repeat(64) })).status,
    401,
  );
  assert.equal(
    (await f.rpc(send(), undefined, undefined, { 'x-cc-timestamp': String(now - 60001) })).status,
    401,
  );
  assert.equal((await f.rpc(send(), undefined, undefined, { authorization: '' })).status, 401);
  assert.equal((await f.rpc('{broken')).body.error.code, -32700);
  assert.equal((await f.rpc(send(randomUUID(), 'x'.repeat(12001)))).body.error.code, -32602);
  assert.equal((await f.rpc(send(randomUUID(), 'x'.repeat(65536)))).status, 413);
  const blocking = send();
  blocking.params.configuration.returnImmediately = false;
  assert.equal((await f.rpc(blocking)).body.error.code, -32602);
  assert.equal(
    (await f.rpc({ ...send(), method: 'SendStreamingMessage' })).body.error.code,
    -32004,
  );
  assert.equal((await f.rpc([send()])).body.error.code, -32600);
  const payload = JSON.stringify(send());
  const headers = sign(f.requester.token, f.path, payload);
  assert.equal(
    (await fetch(f.base + f.path, { method: 'POST', headers, body: payload })).status,
    200,
  );
  assert.equal(
    (await fetch(f.base + f.path, { method: 'POST', headers, body: payload })).status,
    409,
  );
  assert.equal((await http(f.base, '/.well-known/agent-card.json')).status, 404);
});

test('real HTTP operations reject authority removed after authentication before mutation', async (t) => {
  for (const change of ['rotate', 'revoke-grant']) {
    for (const operation of ['SendMessage', 'GetTask', 'CancelTask']) {
      await t.test(`${change}: ${operation}`, async (subtest) => {
        const f = await fixture(subtest);
        const task = (await f.rpc(send())).body.result.task;
        let release!: () => void;
        let observed!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const reached = new Promise<void>((resolve) => {
          observed = resolve;
        });
        subtest.after(async () => release());
        const original = f.app.city.db.transaction.bind(f.app.city.db);
        let armed = true;
        const mock = subtest.mock.method(
          f.app.city.db,
          'transaction',
          async <T>(callback: (tx: Tx) => Promise<T>) => {
            const pause = armed;
            armed = false;
            const result = await original(callback);
            if (pause) {
              observed();
              await gate;
            }
            return result;
          },
        );
        const pending = f.rpc(
          operation === 'SendMessage' ? send() : taskRequest(operation, task.id),
        );
        await reached;
        if (change === 'rotate')
          await http(f.base, `/api/agents/${f.requester.agent.id}/rotate-credential`, {}, f.cookie);
        else await http(f.base, `/api/connections/${f.grant.id}`, undefined, f.cookie, 'DELETE');
        release();
        assert.equal((await pending).status, change === 'rotate' ? 401 : 403);
        mock.mock.restore();
      });
    }
  }
});

test('cancel and hosted completion serialize without reopening terminal work', async (t) => {
  const f = await fixture(t);
  const task = (await f.rpc(send())).body.result.task;
  await f.app.city.tick();
  const [canceled] = await Promise.all([
    f.rpc(taskRequest('CancelTask', task.id)),
    f.app.city.tick(),
  ]);
  const current = (await f.rpc(taskRequest('GetTask', task.id))).body.result;
  if (canceled.body.result) {
    assert.equal(current.status.state, 'TASK_STATE_CANCELED');
    assert.equal(current.artifacts, undefined);
  } else {
    assert.equal(canceled.body.error.code, -32002);
    assert.equal(current.status.state, 'TASK_STATE_COMPLETED');
  }
  await f.app.city.tick();
  assert.deepEqual((await f.rpc(taskRequest('GetTask', task.id))).body.result, current);
});
