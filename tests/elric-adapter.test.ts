import test from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  AdapterError,
  OpenAICompatibleAdapter,
  checkBaseUrl,
  elricHosted,
  type ModelRequest,
} from '../server/elric/adapter.js';
import { elricEndpoints, elricMockModels, elricModels } from '../server/elric/endpoints.js';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import {
  ELRIC_CONFIG,
  ELRIC_COST_UNIT_USD,
  elricRateConfig,
  elricRates,
  unitsPer1kFromGpu,
} from '../server/elric/config.js';
import { toolSpecs } from '../server/elric/tools.js';
import { chatCompletion, closedPort, modelServer } from './elric-model-server.js';

/**
 * The self-hosted model client against a local mock OpenAI-compatible server (127.0.0.1, no
 * network): the real transport (node:http, connect and total timeouts, size caps, no redirects),
 * fixed error codes, endpoint configuration from the environment, and usage → cost units.
 */
const request = (extra: Partial<ModelRequest> = {}): ModelRequest => ({
  system: 'You are Elric.',
  messages: [{ role: 'user', content: 'What is new here?' }],
  maxOutputTokens: 600,
  ...extra,
});
const adapter = (
  url: string,
  options: Partial<ConstructorParameters<typeof OpenAICompatibleAdapter>[0]> = {},
) =>
  new OpenAICompatibleAdapter({
    baseUrl: url,
    model: 'served-small',
    allowLoopback: true,
    ...options,
  });
const rejectsWith = async (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof AdapterError, String(error));
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /secret|detail|internal/i);
    return true;
  });

test('success: text, usage and model; one POST, no streaming, bearer only when configured', async (t) => {
  const server = await modelServer(t);
  server.push({
    json: chatCompletion({ content: 'All quiet.' }, { prompt_tokens: 1500, completion_tokens: 40 }),
  });
  const plain = await adapter(server.url).complete(request());
  assert.deepEqual(plain, {
    text: 'All quiet.',
    toolCalls: [],
    usage: { inputTokens: 1500, outputTokens: 40, reported: true },
    model: 'served-small',
  });
  const [sent] = server.chats();
  assert.equal(sent!.method, 'POST');
  assert.equal(sent!.body!.stream, false);
  assert.equal(sent!.body!.max_tokens, 600);
  assert.equal(sent!.body!.model, 'served-small');
  assert.equal(sent!.headers.authorization, undefined);
  const apiKey = randomBytes(24).toString('base64url');
  await adapter(server.url, { apiKey }).complete(request());
  assert.equal(server.chats()[1]!.headers.authorization, `Bearer ${apiKey}`);
});

test('tool calls are parsed (arguments as objects; anything else null) and tools are sent', async (t) => {
  const server = await modelServer(t);
  server.push({
    json: chatCompletion({
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'room_read', arguments: '{"since":4}' } },
        { id: 'c2', type: 'function', function: { name: 'room_read', arguments: '[1,2]' } },
        { id: 'c3', type: 'function', function: { name: 'room_read', arguments: 'not json' } },
      ],
    }),
  });
  const result = await adapter(server.url).complete(request({ tools: toolSpecs(true) }));
  assert.equal(result.text, null);
  assert.deepEqual(
    result.toolCalls.map((call) => [call.id, call.name, call.args]),
    [
      ['c1', 'room_read', { since: 4 }],
      ['c2', 'room_read', null],
      ['c3', 'room_read', null],
    ],
  );
  const sentTools = server.chats()[0]!.body!.tools as Array<{ function: { name: string } }>;
  assert.deepEqual(
    sentTools.map((tool) => tool.function.name),
    toolSpecs(true).map((tool) => tool.name),
  );
});

test('failures are fixed codes: 5xx, 503 waking, 4xx, malformed JSON, no redirects', async (t) => {
  const server = await modelServer(t);
  const secretBody = { error: { message: 'internal detail: secret stack trace' } };
  const cases: Array<[Parameters<typeof server.push>[0], string]> = [
    [{ json: secretBody, status: 500 }, 'server_error'],
    [{ json: secretBody, status: 502 }, 'server_error'],
    [{ json: secretBody, status: 503 }, 'waking'],
    [{ json: secretBody, status: 401 }, 'unauthorized'],
    [{ json: secretBody, status: 404 }, 'model_unavailable'],
    [{ json: secretBody, status: 429 }, 'rate_limited'],
    [{ json: secretBody, status: 400 }, 'bad_request'],
    [{ raw: '{"choices": [', status: 200 }, 'bad_response'],
    [{ raw: 'secret plain text', status: 200 }, 'bad_response'],
    [{ json: { choices: [] } }, 'bad_response'],
    [
      { json: secretBody, status: 302, headers: { location: 'http://127.0.0.1:1/' } },
      'bad_response',
    ],
  ];
  for (const [step, code] of cases) {
    server.push(step);
    await rejectsWith(adapter(server.url).complete(request()), code);
  }
  // The redirect was not followed: exactly one request per case reached the server.
  assert.equal(server.chats().length, cases.length);
});

test('oversized responses are refused (declared or streamed), and so are oversized requests', async (t) => {
  const server = await modelServer(t);
  server.push({ raw: '{}', headers: { 'content-length': '5000000' } });
  // A declared length over the cap is refused before reading.
  await rejectsWith(adapter(server.url).complete(request()), 'too_large');
  server.push({ bigBytes: 2_000_000 });
  await rejectsWith(adapter(server.url).complete(request()), 'too_large');
  const before = server.chats().length;
  await rejectsWith(
    adapter(server.url).complete(request({ system: 'x'.repeat(600_000) })),
    'too_large',
  );
  assert.equal(server.chats().length, before, 'an oversized request is never sent');
});

test('timeouts: a slow answer is a timeout; a refused or dropped connection is waking', async (t) => {
  const server = await modelServer(t);
  server.push({ delayMs: 500, then: { json: chatCompletion({ content: 'late' }) } });
  await rejectsWith(adapter(server.url, { timeoutMs: 100 }).complete(request()), 'timeout');
  // Dropped after the request was written: the server may have worked on it (counted as sent).
  server.push({ hangUp: true });
  await rejectsWith(adapter(server.url).complete(request()), 'server_error');
  const port = await closedPort();
  await rejectsWith(adapter(`http://127.0.0.1:${port}`).complete(request()), 'waking');
});

test('health probe: GET /v1/models, ready / waking / down, never throws', async (t) => {
  const server = await modelServer(t);
  assert.deepEqual(await adapter(server.url).probe(), { state: 'ready' });
  server.setModelsStatus(503);
  assert.deepEqual(await adapter(server.url).probe(), { state: 'waking', code: 'waking' });
  server.setModelsStatus(500);
  assert.deepEqual(await adapter(server.url).probe(), { state: 'down', code: 'server_error' });
  const port = await closedPort();
  assert.equal((await adapter(`http://127.0.0.1:${port}`).probe()).state, 'waking');
  assert.ok(server.requests.every((item) => item.path === '/v1/models'));
  assert.equal(server.chats().length, 0, 'a probe never spends tokens');
});

test('endpoints from the environment: https only, loopback only off a deployment, pairs required', () => {
  assert.deepEqual(elricEndpoints({}), {});
  const env = {
    CITY_ELRIC_T1_URL: 'https://small.models.example.test',
    CITY_ELRIC_T1_MODEL: 'org/small-model-8b',
    CITY_ELRIC_T2_URL: 'https://large.models.example.test/base',
    CITY_ELRIC_T2_MODEL: 'org/large-model-70b',
  };
  const endpoints = elricEndpoints(env);
  assert.equal(endpoints[1]!.model, 'org/small-model-8b');
  assert.equal(endpoints[2]!.baseUrl, 'https://large.models.example.test/base');
  // 45 s on both tiers: a full 600-token answer on an L4 takes about 35 s.
  assert.deepEqual([endpoints[1]!.timeoutMs, endpoints[2]!.timeoutMs], [45_000, 45_000]);
  for (const bad of [
    { CITY_ELRIC_T1_URL: 'https://a.example.test' },
    { CITY_ELRIC_T1_MODEL: 'small' },
    { CITY_ELRIC_T1_URL: 'http://a.example.test', CITY_ELRIC_T1_MODEL: 'm' },
    { CITY_ELRIC_T1_URL: 'https://u:p@a.example.test', CITY_ELRIC_T1_MODEL: 'm' },
    { CITY_ELRIC_T1_URL: 'https://10.0.0.5', CITY_ELRIC_T1_MODEL: 'm' },
    { CITY_ELRIC_T1_URL: 'https://a.example.test', CITY_ELRIC_T1_MODEL: 'bad model name' },
    { CITY_ELRIC_T1_URL: 'http://127.0.0.1:8000', CITY_ELRIC_T1_MODEL: 'm', VERCEL: '1' },
    {
      CITY_ELRIC_T1_URL: 'https://a.example.test',
      CITY_ELRIC_T1_MODEL: 'm',
      CITY_ELRIC_MODEL_KEY: 'short',
    },
  ])
    assert.throws(
      () => elricModels(bad),
      (error: Error) => !/example|10\.0|u:p/.test(error.message),
    );
  // Loopback in development; a missing tier answers model_unavailable.
  const models = elricModels({
    CITY_ELRIC_T1_URL: 'http://127.0.0.1:8000',
    CITY_ELRIC_T1_MODEL: 'm',
  });
  assert.ok(models?.adapters[1]);
  assert.equal(models?.adapters[2], undefined);
  assert.equal(models!.adapterFor(2).model, ELRIC_CONFIG.models[2]);
  assert.equal(elricModels({}), null);
  assert.throws(() => checkBaseUrl('http://127.0.0.1:8000', false));
});

test("usage → cost units: per-tier rates from measured GPU seconds (defaults keep today's numbers)", () => {
  // Defaults: USD 2.50 per GPU hour; one unit is 1 micro-USD (migration 45), so a GPU-second is
  // 694.4 units. The self-hosted fallback keeps these GPU rates (same dollars as before x2500).
  assert.equal(ELRIC_COST_UNIT_USD, 0.000001);
  assert.deepEqual(ELRIC_CONFIG.unitsPer1kTokens, {
    1: { input: 125, output: 3750 },
    2: { input: 750, output: 20000 },
  });
  // Reservation per step: 72k context + 4,400 output (answer + thinking) at the tier rate.
  assert.deepEqual(ELRIC_CONFIG.unitsPerStep, { 1: 25_500, 2: 142_000 });
  // A measured run: GPU at USD 1.80/h, Tier 1 at 0.36 s / 9 s per 1k tokens, Tier 2 unchanged.
  const rates = elricRates({
    CITY_ELRIC_GPU_USD_PER_HOUR: '1.8',
    CITY_ELRIC_T1_GPU_S_PER_1K_IN: '0.36',
    CITY_ELRIC_T1_GPU_S_PER_1K_OUT: '9',
  });
  // 1.80 / 3600 / 0.000001 = 500 units per GPU-second.
  assert.deepEqual(unitsPer1kFromGpu(rates)[1], { input: 180, output: 4500 });
  const derived = elricRateConfig(rates);
  // Reservation per step: 72k context + 4,400 output at the tier rate, rounded up.
  assert.equal(derived.unitsPerStep[1], Math.ceil(72 * 180 + 4.4 * 4500));
  for (const bad of ['0', '-1', 'abc', 'Infinity'])
    assert.throws(() => elricRates({ CITY_ELRIC_GPU_USD_PER_HOUR: bad }));
});

test('CITY_ELRIC_MOCK=1 is for local tests only: refused on a deployment and in production', async () => {
  assert.equal(elricMockModels({}), null);
  const local = elricMockModels({ CITY_ELRIC_MOCK: '1' });
  const reply = await local!.adapterFor(1).complete({
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    maxOutputTokens: 10,
  });
  assert.equal(reply.text, 'Mock reply.');
  for (const env of [
    { CITY_ELRIC_MOCK: '1', VERCEL: '1' },
    { CITY_ELRIC_MOCK: '1', CITY_HOSTED: '1' },
    { CITY_ELRIC_MOCK: '1', NODE_ENV: 'production' },
  ])
    assert.throws(() => elricMockModels(env), /local tests only/);
  assert.throws(() => elricMockModels({ CITY_ELRIC_MOCK: '1' }, true), /local tests only/);
  // The app refuses to start with it in hosted mode.
  const saved = { mock: process.env.CITY_ELRIC_MOCK, key: process.env.CITY_RATE_LIMIT_KEY };
  process.env.CITY_ELRIC_MOCK = '1';
  process.env.CITY_RATE_LIMIT_KEY ??= randomBytes(32).toString('base64url');
  try {
    await assert.rejects(
      createApp({
        database: await PGlite.create('memory://'),
        hosted: {
          databaseUrl: 'postgres://unused.invalid/test',
          publicOrigin: 'https://centralcity.ai',
          allowedOrigins: ['https://centralcity.ai'],
        },
        startWorkers: false,
        elric: { enabled: true, autoDrain: false },
      }),
      // Hosted startup reports any failure generically; it does not start.
      /initialization failed/,
    );
    // Off a hosted deployment, NODE_ENV=production refuses it with the reason.
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await assert.rejects(
        createApp({
          dataDir: ':memory:',
          startWorkers: false,
          elric: { enabled: true, autoDrain: false },
        }),
        /local tests only/,
      );
    } finally {
      if (savedEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = savedEnv;
    }
  } finally {
    if (saved.mock === undefined) delete process.env.CITY_ELRIC_MOCK;
    else process.env.CITY_ELRIC_MOCK = saved.mock;
    if (saved.key === undefined) delete process.env.CITY_RATE_LIMIT_KEY;
    else process.env.CITY_RATE_LIMIT_KEY = saved.key;
  }
});

test('errors say whether the request was sent (GPU time may have been used)', async (t) => {
  const server = await modelServer(t);
  const sentOf = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return [(error as AdapterError).code, (error as AdapterError).sent];
    }
    return null;
  };
  server.push({ json: {}, status: 500 });
  assert.deepEqual(await sentOf(adapter(server.url).complete(request())), ['server_error', true]);
  server.push({ json: {}, status: 503 });
  assert.deepEqual(await sentOf(adapter(server.url).complete(request())), ['waking', false]);
  server.push({ raw: 'not json' });
  assert.deepEqual(await sentOf(adapter(server.url).complete(request())), ['bad_response', true]);
  server.push({ bigBytes: 2_000_000 });
  assert.deepEqual(await sentOf(adapter(server.url).complete(request())), ['too_large', true]);
  server.push({ delayMs: 500, then: { json: chatCompletion({ content: 'late' }) } });
  assert.deepEqual(await sentOf(adapter(server.url, { timeoutMs: 100 }).complete(request())), [
    'timeout',
    true,
  ]);
  // A per-call limit below the tier timeout wins.
  server.push({ delayMs: 500, then: { json: chatCompletion({ content: 'late' }) } });
  assert.deepEqual(await sentOf(adapter(server.url).complete(request({ timeoutMs: 100 }))), [
    'timeout',
    true,
  ]);
  // Never sent: an oversized request, a refused connection.
  assert.deepEqual(
    await sentOf(adapter(server.url).complete(request({ system: 'x'.repeat(600_000) }))),
    ['too_large', false],
  );
  const port = await closedPort();
  assert.deepEqual(await sentOf(adapter(`http://127.0.0.1:${port}`).complete(request())), [
    'waking',
    false,
  ]);
  // No usage counts in the answer: marked, so the service charges its estimate.
  const bare = chatCompletion({ content: 'ok' });
  delete (bare as { usage?: unknown }).usage;
  server.push({ json: bare });
  assert.equal((await adapter(server.url).complete(request())).usage.reported, false);
});

test('a non-200 answer body is closed, not left open', async () => {
  let cancelled = 0;
  const failing = new OpenAICompatibleAdapter({
    baseUrl: 'https://models.example.test',
    model: 'm',
    fetch: async () => ({
      status: 500,
      body: new ReadableStream<Uint8Array>({
        pull() {},
        cancel() {
          cancelled++;
        },
      }),
    }),
  });
  await assert.rejects(failing.complete(request()));
  assert.equal(cancelled, 1);
});

test('one hosted rule: loopback endpoints refused with VERCEL, CITY_HOSTED, production or a hosted app', () => {
  const loop = { CITY_ELRIC_T1_URL: 'http://127.0.0.1:8000', CITY_ELRIC_T1_MODEL: 'm' };
  assert.ok(elricModels(loop));
  for (const env of [
    { ...loop, VERCEL: '1' },
    { ...loop, CITY_HOSTED: '1' },
    { ...loop, NODE_ENV: 'production' },
  ])
    assert.throws(() => elricModels(env));
  assert.throws(() => elricModels(loop, { hosted: true }));
  for (const env of [{ VERCEL: '1' }, { CITY_HOSTED: '1' }, { NODE_ENV: 'production' }, {}])
    assert.equal(elricHosted(env), Object.keys(env).length > 0);
  assert.equal(elricHosted({}, true), true);
});
