import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseLocalModelConfig } from '../connector/local-model-cli.js';
import { validateHostedAppConfig } from '../connector/hosted-config.js';
import { createLocalModelExecutor } from '../connector/local-model.js';
import {
  readRequestedJob,
  requestPeerJob,
  runConnector,
  runtimeRequest,
  RuntimeError,
} from '../connector/index.js';

const baseUrl = 'https://staging.example.invalid';
const token = 'synthetic-native-token-'.repeat(3);
const protectionBypassToken = 'synthetic-protection-token-'.repeat(3);
const local = {
  baseUrl: 'http://127.0.0.1:4310',
  token,
  sequenceFile: 'agent.sequence',
  modelEndpoint: 'http://127.0.0.1:4322',
  model: 'synthetic-model',
};
const hosted = { ...local, baseUrl, appMode: 'hosted', protectionBypassToken };
const configPath = join(tmpdir(), 'private', 'agent.json');
const config = () => parseLocalModelConfig(hosted, configPath);
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('local-only remains the default and hosted app access requires explicit private opt-in', () => {
  assert.equal(parseLocalModelConfig(local, configPath).hostedApp, undefined);
  assert.equal(
    parseLocalModelConfig({ ...local, appMode: 'local' }, configPath).baseUrl,
    local.baseUrl,
  );
  for (const value of [
    { ...local, baseUrl },
    { ...local, appMode: 'local', baseUrl },
    { ...local, protectionBypassToken },
    { ...hosted, protectionBypassToken: undefined },
    { ...hosted, appMode: 'remote' },
    { ...hosted, extraHeaders: { Authorization: 'arbitrary' } },
    { ...hosted, hostedApp: {} },
  ])
    assert.throws(() => parseLocalModelConfig(value, configPath));
  const parsed = config();
  assert.equal(parsed.baseUrl, baseUrl);
  assert.equal(parsed.hostedApp?.origin, baseUrl);
  assert.ok(Object.isFrozen(parsed.hostedApp));
  assert.equal(parsed.sequenceFile, join(tmpdir(), 'private', 'agent.sequence'));
});

test('hosted mode refuses normalized, insecure or decorated origins and remote model endpoints', () => {
  for (const origin of [
    'http://staging.example.invalid',
    'http://127.0.0.1:4310',
    `${baseUrl}/`,
    `${baseUrl}/api`,
    `${baseUrl}?token=private`,
    `${baseUrl}#fragment`,
    'https://user:private@staging.example.invalid',
    'https://staging.example.invalid:443',
    'https://STAGING.example.invalid',
    ` ${baseUrl}`,
    `${baseUrl}\n`,
    'https:\\staging.example.invalid',
  ])
    assert.throws(() => parseLocalModelConfig({ ...hosted, baseUrl: origin }, configPath));
  for (const modelEndpoint of [
    baseUrl,
    'http://model.example.invalid:4322',
    'http://localhost:4322',
    'http://127.1:4322',
    'http://127.0.0.1:4322/path',
    'http://127.0.0.1:4322?token=private',
  ])
    assert.throws(() => parseLocalModelConfig({ ...hosted, modelEndpoint }, configPath));
  assert.equal(
    parseLocalModelConfig({ ...hosted, modelEndpoint: 'http://[::1]:4322' }, configPath)
      .modelEndpoint,
    'http://[::1]:4322',
  );
});

test('protection configuration is bounded and cannot inject extra headers', () => {
  for (const value of [
    '',
    'x'.repeat(513),
    'x'.repeat(15),
    'x'.repeat(20) + '\r\nheader: value',
    'é'.repeat(32),
  ]) {
    assert.throws(() =>
      parseLocalModelConfig({ ...hosted, protectionBypassToken: value }, configPath),
    );
  }
  assert.throws(() =>
    validateHostedAppConfig({ origin: baseUrl, protectionBypassToken, headers: {} }, baseUrl),
  );
  assert.throws(() =>
    validateHostedAppConfig(
      { origin: baseUrl, protectionBypassToken },
      'https://other.example.invalid',
    ),
  );
});

test('transport rejects changed origins and URL escapes before sending any credential', async (t) => {
  let sent = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    sent++;
    return json({});
  });
  for (const origin of ['https://other.example.invalid', 'http://127.0.0.1:4310', `${baseUrl}/`]) {
    await assert.rejects(
      runtimeRequest({ ...config(), baseUrl: origin }, 'GET', '/api/runtime/jobs'),
    );
  }
  for (const pathname of [
    '//other.example.invalid/api/runtime/jobs',
    '/api/runtime/../../../leak',
    '/api/runtime/jobs/../../leak',
    '/api/runtime/%2e%2e/leak',
    '/api/runtime/jobs\\..\\leak',
    '/api/runtime/jobs?x=1',
    '/api/runtime/jobs#fragment',
    '/api/runtime/jobs\n',
    '/api/runtime/unknown',
  ])
    await assert.rejects(runtimeRequest(config(), 'GET', pathname));
  assert.equal(sent, 0);
});

test('requester helpers attach only scoped protection headers, preserve native auth and reject redirects', async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(input.origin, baseUrl);
    assert.ok(headers.get('x-vercel-protection-bypass') === protectionBypassToken);
    assert.ok(headers.get('authorization') === `Bearer ${token}`);
    assert.ok(headers.has('x-cc-signature'));
    assert.equal(headers.has('x-vercel-set-bypass-cookie'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(init.redirect, 'error');
    assert.ok(!String(init.body).includes(protectionBypassToken));
    paths.push(input.pathname);
    if (input.pathname === '/api/runtime/jobs')
      return new Response(null, {
        status: 302,
        headers: { location: 'https://other.example.invalid/leak' },
      });
    return json({ job: { id: 'synthetic-request' } });
  });
  const requested = await requestPeerJob(config(), {
    providerId: 'synthetic-provider',
    input: 'Synthetic source',
    idempotencyKey: 'synthetic-request',
  });
  assert.equal(requested.id, 'synthetic-request');
  await readRequestedJob(config(), requested.id);
  await assert.rejects(runtimeRequest(config(), 'GET', '/api/runtime/jobs'), RuntimeError);
  assert.deepEqual(paths, [
    '/api/runtime/requests',
    '/api/runtime/requests/synthetic-request',
    '/api/runtime/jobs',
  ]);
});

test(
  'hosted connector fixture keeps both credentials out of model traffic, results and events',
  { timeout: 5_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'city-hosted-connector-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    t.after(() => controller.abort());
    const events: unknown[] = [];
    let modelCalls = 0;
    let deliveries = 0;
    const source = 'Synthetic test source.';
    t.mock.method(globalThis, 'fetch', async (input: URL, init: RequestInit) => {
      const headers = new Headers(init.headers);
      const body = String(init.body ?? '');
      assert.ok(!body.includes(token) && !body.includes(protectionBypassToken));
      if (input.origin === local.modelEndpoint) {
        modelCalls++;
        assert.equal(input.pathname, '/v1/chat/completions');
        assert.equal(headers.has('x-vercel-protection-bypass'), false);
        assert.equal(headers.has('authorization'), false);
        return json({
          model: local.model,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  title: 'Synthetic test',
                  summary: source,
                  keyPoints: [source],
                  sourceQuotes: [source],
                  limitations: ['Synthetic fixture only.'],
                }),
              },
            },
          ],
        });
      }
      assert.equal(input.origin, baseUrl);
      assert.ok(headers.get('x-vercel-protection-bypass') === protectionBypassToken);
      assert.equal(init.redirect, 'error');
      if (input.pathname === '/api/runtime/jobs')
        return json({
          job: { id: 'synthetic-job', capability: 'research', input: source },
          leaseToken: 'synthetic-lease-token-1234',
        });
      if (input.pathname.endsWith('/result')) {
        deliveries++;
        assert.equal(JSON.parse(body).output.execution, 'local-language-model');
      }
      return json({ ok: true });
    });
    await runConnector({
      ...config(),
      sequenceFile: join(directory, 'sequence'),
      signal: controller.signal,
      execute: createLocalModelExecutor({ endpoint: local.modelEndpoint, model: local.model }),
      onEvent: (event) => {
        events.push(event);
        if (event.type === 'completed') controller.abort();
      },
    });
    assert.equal(modelCalls, 1);
    assert.equal(deliveries, 1);
    assert.ok(
      !JSON.stringify(events).includes(token) &&
        !JSON.stringify(events).includes(protectionBypassToken),
    );
  },
);

test('transport and malformed response errors never retain echoed private credentials', async (t) => {
  const hostile = `${token} ${protectionBypassToken}`;
  for (const behavior of [
    async () => {
      throw new Error(hostile);
    },
    async () => new Response(hostile),
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error(hostile));
          },
        }),
      ),
    async () => new Response(hostile, { status: 403 }),
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', behavior);
    await assert.rejects(runtimeRequest(config(), 'GET', '/api/runtime/jobs'), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(
        !String(error.stack).includes(token) &&
          !String(error.stack).includes(protectionBypassToken),
      );
      assert.equal(error.cause, undefined);
      return true;
    });
    mock.mock.restore();
  }
});

test('CLI rejects invalid or oversized private configuration without logging credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'city-hosted-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'private.json');
  const cli = fileURLToPath(new URL('../connector/local-model-cli.ts', import.meta.url));
  for (const value of [
    { ...hosted, baseUrl: 'http://remote.example.invalid' },
    { ...hosted, padding: 'x'.repeat(8192) },
  ]) {
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    await assert.rejects(
      promisify(execFile)(process.execPath, ['--import', 'tsx', cli, 'connect', path], {
        timeout: 5_000,
      }),
      (error: unknown) => {
        const result = error as { stdout: string; stderr: string; code: number };
        assert.equal(result.code, 1);
        assert.match(result.stderr, /Local model connector stopped/);
        assert.ok(!(result.stdout + result.stderr).includes(token));
        assert.ok(!(result.stdout + result.stderr).includes(protectionBypassToken));
        return true;
      },
    );
  }
});
