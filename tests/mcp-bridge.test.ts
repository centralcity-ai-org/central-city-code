import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createApp } from '../server/app.js';
import { configSchema, loadConfig, callCityTool, LIMITS } from '../mcp/bridge.js';

const token = () => randomBytes(32).toString('base64url');
const scripts = resolve('node_modules/tsx/dist/cli.mjs');
async function connect(configFile: string, modern = true) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [scripts, resolve('mcp/cli.ts'), '--config', configFile],
    stderr: 'pipe',
    cwd: process.cwd(),
  });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const client = new Client(
    { name: 'independent-city-test', version: '1.0.0' },
    { versionNegotiation: { mode: modern ? 'auto' : 'legacy' } },
  );
  await client.connect(transport);
  return { client, stderr: () => stderr };
}
const data = (result: Awaited<ReturnType<Client['callTool']>>) => {
  assert.ok(!result.isError, JSON.stringify(result));
  const text = result.content.find((part) => part.type === 'text');
  assert.ok(text && text.type === 'text');
  return JSON.parse(text.text);
};

test('private config rejects non-loopback destinations, aliases, oversized and malformed files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'city-mcp-config-'));
  try {
    const credential = token();
    for (const baseUrl of [
      'https://127.0.0.1:4310',
      'http://localhost:4310',
      'http://127.1',
      'http://2130706433',
      'http://0x7f000001',
      'http://user@127.0.0.1',
      'http://127.0.0.1/a',
      'http://127.0.0.1?x=1',
      'http://127.0.0.1#x',
      'http://10.0.0.1',
      'http://127.0.0.1:99999',
    ])
      assert.equal(configSchema.safeParse({ baseUrl, token: credential }).success, false, baseUrl);
    for (const baseUrl of ['http://127.0.0.1:4310', 'http://[::1]:4310/'])
      assert.equal(configSchema.safeParse({ baseUrl, token: credential }).success, true);
    const path = join(root, 'config.json');
    await writeFile(path, JSON.stringify({ baseUrl: 'http://127.0.0.1:4310', token: credential }), {
      mode: 0o600,
    });
    assert.equal((await loadConfig(path)).token, credential);
    await assert.rejects(loadConfig('relative.json'), /absolute/);
    await writeFile(path, 'x'.repeat(LIMITS.configBytes + 1));
    await assert.rejects(loadConfig(path), /large/);
    await writeFile(path, '{broken');
    await assert.rejects(loadConfig(path));
    if (process.platform !== 'win32') {
      await chmod(path, 0o644);
      await assert.rejects(loadConfig(path), /private/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bridge bounds HTTP, rejects redirects/errors, never echoes its credential or retries writes', async (t) => {
  let mode = 'ok',
    calls = 0,
    redirectedCalls = 0;
  const credential = token();
  const target = createServer((_request, reply) => {
    redirectedCalls++;
    reply.end('{}');
  });
  await new Promise<void>((done) => target.listen(0, '127.0.0.1', done));
  const redirectPort = (target.address() as { port: number }).port;
  const upstream = createServer((request, reply) => {
    calls++;
    assert.equal(request.url, '/api/assistant/tools/city_workspace');
    assert.equal(request.headers.authorization, `Bearer ${credential}`);
    if (mode === 'redirect') {
      reply.writeHead(302, { location: `http://127.0.0.1:${redirectPort}/stolen` });
      reply.end();
      return;
    }
    if (mode === 'timeout') return;
    reply.setHeader('content-type', 'application/json');
    if (mode === 'error') {
      reply.statusCode = 500;
      reply.end(JSON.stringify({ error: credential }));
      return;
    }
    if (mode === 'large') {
      reply.end(JSON.stringify({ value: 'x'.repeat(LIMITS.responseBytes) }));
      return;
    }
    if (mode === 'secret') {
      reply.end(JSON.stringify({ token: credential }));
      return;
    }
    if (mode === 'escaped-secret') {
      reply.end(
        `{"token":"${[...credential].map((character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')}"}`,
      );
      return;
    }
    if (mode === 'invalid') {
      reply.end('{broken');
      return;
    }
    reply.end(JSON.stringify({ safe: true }));
  });
  await new Promise<void>((done) => upstream.listen(0, '127.0.0.1', done));
  t.after(async () => {
    upstream.closeAllConnections();
    target.closeAllConnections();
    await Promise.all([
      new Promise<void>((done) => upstream.close(() => done())),
      new Promise<void>((done) => target.close(() => done())),
    ]);
  });
  const config = {
    baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    token: credential,
  };
  assert.ok(!(await callCityTool(config, 'city_workspace', {})).isError);
  // Each mode must fail for its own reason. Only the hanging upstream needs a short bound: a 30 ms bound on
  // every mode let a loaded runner abort before the request reached the upstream (calls - before === 0),
  // and let a redirect or secret case pass only because it timed out.
  const unreachable = /could not be reached safely/;
  const expected: Record<string, RegExp> = {
    redirect: unreachable,
    error: /rejected the request/,
    large: /exceeds the bridge limit/,
    secret: /unsupported response/,
    'escaped-secret': /unsupported response/,
    invalid: unreachable,
    timeout: unreachable,
  };
  for (mode of Object.keys(expected)) {
    const before = calls;
    const result = await callCityTool(
      config,
      'city_workspace',
      {},
      mode === 'timeout' ? 1_000 : undefined,
    );
    assert.ok(result.isError, mode);
    assert.match(result.content[0]!.text, expected[mode]!, mode);
    assert.equal(calls - before, 1, mode);
    assert.ok(!JSON.stringify(result).includes(credential));
  }
  assert.equal(redirectedCalls, 0);
  const before = calls;
  assert.ok((await callCityTool(config, 'city_workspace', { token: credential })).isError);
  assert.equal(calls, before);
});

test('stdio startup failures and oversized frames emit no configuration secrets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'city-mcp-wire-'));
  const secret = token();
  const path = join(root, 'private.json');
  try {
    await writeFile(path, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: secret }), {
      mode: 0o600,
    });
    async function run(args: string[], input: string) {
      return new Promise<{ stdout: string; stderr: string; code: number | null }>(
        (done, reject) => {
          const child = spawn(process.execPath, [scripts, resolve('mcp/cli.ts'), ...args], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          });
          let stdout = '',
            stderr = '';
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Bridge did not terminate.'));
          }, 5000);
          child.stdout.on('data', (value) => {
            stdout += value.toString();
          });
          child.stderr.on('data', (value) => {
            stderr += value.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => {
            clearTimeout(timeout);
            done({ stdout, stderr, code });
          });
          child.stdin.on('error', () => {});
          child.stdin.end(input);
        },
      );
    }
    const failed = await run(['--token', secret], '');
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');
    assert.ok(!failed.stderr.includes(secret));
    const oversized = await run(['--config', path], 'x'.repeat(65537));
    assert.equal(oversized.stdout, '');
    assert.ok(!oversized.stderr.includes(secret));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('official SDK stdio client lists and calls fixed tools against real owner-scoped HTTP grants', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'city-mcp-sdk-'));
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  async function owner(name: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'x-city-request': '1', 'content-type': 'application/json' },
      payload: { name, password: 'Synthetic MCP fixture password' },
    });
    assert.equal(response.statusCode, 201, response.body);
    return `cc_session=${response.cookies[0]!.value}`;
  }
  const cookie = await owner('MCP owner');
  const api = (
    path: string,
    body?: unknown,
    method: 'POST' | 'DELETE' = 'POST',
    selectedCookie = cookie,
  ) =>
    app.inject({
      method,
      url: path,
      headers: {
        cookie: selectedCookie,
        'x-city-request': '1',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { payload: body as object }),
    });
  const granted = await api('/api/assistant-access', {
    label: 'SDK test',
    scopes: ['workspace:read', 'agents:create', 'jobs:create', 'jobs:cancel'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const grant = granted.json();
  const configPath = join(root, 'full.json');
  await writeFile(configPath, JSON.stringify({ baseUrl, token: grant.token }), { mode: 0o600 });
  const { client, stderr } = await connect(configPath);
  clients.push(client);
  assert.equal(client.getNegotiatedProtocolVersion(), '2026-07-28');
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [
    'city_ack_inbox',
    'city_apply_team',
    'city_cancel_job',
    'city_control',
    'city_create_agent',
    'city_create_job',
    'city_get_job',
    'city_list_templates',
    'city_plan_team',
    'city_read_inbox',
    'city_send_message',
    'city_workspace',
  ]);
  const workspace = data(await client.callTool({ name: 'city_workspace', arguments: {} }));
  assert.equal(workspace.operator.name, 'MCP owner');
  assert.ok(!JSON.stringify(workspace).includes(grant.token));
  const agentArgs = {
    name: 'SDK requester',
    description: 'Synthetic',
    mode: 'hosted',
    capability: 'extract',
    idempotencyKey: randomUUID(),
  };
  const requester = data(
    await client.callTool({ name: 'city_create_agent', arguments: agentArgs }),
  ).agent;
  assert.equal(
    data(await client.callTool({ name: 'city_create_agent', arguments: agentArgs })).agent.id,
    requester.id,
  );
  assert.ok(
    (
      await client.callTool({
        name: 'city_create_agent',
        arguments: { ...agentArgs, name: 'Changed' },
      })
    ).isError,
  );
  const provider = data(
    await client.callTool({
      name: 'city_create_agent',
      arguments: { ...agentArgs, name: 'SDK provider', idempotencyKey: randomUUID() },
    }),
  ).agent;
  const external = data(
    await client.callTool({
      name: 'city_create_agent',
      arguments: {
        ...agentArgs,
        name: 'SDK external',
        mode: 'external',
        idempotencyKey: randomUUID(),
      },
    }),
  );
  assert.equal(external.runtimeSetupRequired, true);
  assert.equal(external.token, undefined);
  await app.city.tick();
  const jobArgs = {
    requesterId: requester.id,
    providerId: provider.id,
    input: 'Synthetic: 42',
    idempotencyKey: randomUUID(),
  };
  assert.ok((await client.callTool({ name: 'city_create_job', arguments: jobArgs })).isError);
  assert.equal(
    (await api('/api/connections', { fromAgentId: requester.id, toAgentId: provider.id }))
      .statusCode,
    201,
  );
  const job = data(await client.callTool({ name: 'city_create_job', arguments: jobArgs })).job;
  assert.equal(
    data(await client.callTool({ name: 'city_get_job', arguments: { id: job.id } })).job.id,
    job.id,
  );
  assert.equal(
    data(await client.callTool({ name: 'city_cancel_job', arguments: { id: job.id } })).ok,
    true,
  );
  const otherCookie = await owner('Other MCP owner');
  const readGrant = (
    await api(
      '/api/assistant-access',
      { label: 'Read only', scopes: ['workspace:read'], expiresInDays: 1 },
      'POST',
      otherCookie,
    )
  ).json();
  const readConfig = join(root, 'read.json');
  await writeFile(readConfig, JSON.stringify({ baseUrl, token: readGrant.token }), { mode: 0o600 });
  const legacy = await connect(readConfig, false);
  clients.push(legacy.client);
  assert.equal(legacy.client.getProtocolEra(), 'legacy');
  t.diagnostic(
    `SDK2.1.0 negotiated modern ${client.getNegotiatedProtocolVersion()} and legacy ${legacy.client.getNegotiatedProtocolVersion()}.`,
  );
  assert.ok(
    (await legacy.client.callTool({ name: 'city_create_agent', arguments: agentArgs })).isError,
  );
  assert.ok(
    (await legacy.client.callTool({ name: 'city_get_job', arguments: { id: job.id } })).isError,
  );
  assert.equal(
    (await api(`/api/assistant-access/${grant.grant.id}`, undefined, 'DELETE')).statusCode,
    200,
  );
  assert.ok((await client.callTool({ name: 'city_workspace', arguments: {} })).isError);
  assert.ok(!stderr().includes(grant.token));
});
