import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import { SequenceStore } from '../connector/sequence.js';
import {
  runtimeRequest,
  runConnector,
  serializeOutput,
  validateBaseUrl,
} from '../connector/index.js';
import { deterministicExecutor } from '../connector/demo-executor.js';
import type { Job } from '../shared/types.js';

test('connector sequence survives clean restart and prevents duplicate local owners', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'central-city-sequence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sequence');
  const first = await SequenceStore.acquire(path);
  assert.equal(await first.next(), 0);
  await assert.rejects(SequenceStore.acquire(path), /lock/);
  assert.equal(await first.next(), 1);
  assert.equal(await readFile(path, 'utf8'), '1');
  await first.close();
  const second = await SequenceStore.acquire(path);
  assert.equal(await second.next(), 2);
  await second.close();
});

test('connector rejects unsafe origins and bounds serialized executor output', () => {
  for (const origin of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com/?token=x',
  ]) {
    assert.throws(() => validateBaseUrl(origin));
  }
  assert.equal(validateBaseUrl('http://127.0.0.1:3001').origin, 'http://127.0.0.1:3001');
  assert.throws(() => serializeOutput(['not', 'an', 'object']));
  assert.throws(() => serializeOutput({ value: 'x'.repeat(32 * 1024) }));
  assert.deepEqual(serializeOutput({ client: 'Northwind' }), { client: 'Northwind' });
});

test('native connector signs transmitted bytes and never follows a redirect with a bearer token', async (t) => {
  let redirected = false;
  const token = 'a'.repeat(64);
  const server = createServer(async (req, res) => {
    if (req.url === '/leak') {
      redirected = true;
      res.end('{}');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString('utf8');
    const canonical = [
      req.method,
      req.url,
      req.headers['x-cc-timestamp'],
      req.headers['x-cc-nonce'],
      createHash('sha256').update(body).digest('hex'),
    ].join('\n');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    assert.equal(
      req.headers['x-cc-signature'],
      createHmac('sha256', token).update(canonical).digest('hex'),
    );
    if (req.url === '/api/runtime/jobs') {
      res.writeHead(302, { location: '/leak' });
      res.end();
    } else {
      assert.equal(JSON.parse(body).sequence, 7);
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = { baseUrl: `http://127.0.0.1:${address.port}`, token };
  assert.deepEqual(
    await runtimeRequest(config, 'POST', '/api/runtime/heartbeat', { sequence: 7 }),
    { ok: true },
  );
  await assert.rejects(runtimeRequest(config, 'GET', '/api/runtime/jobs'));
  assert.equal(redirected, false);
});

test('the deterministic connector extracts actual supplied text and labels its limitations', async () => {
  const job = {
    capability: 'extract',
    input:
      'Client: Northwind\nContact: owner@example.com\nRevenue: $123.45\nSource: https://example.com/report',
  } as Job;
  const output = await deterministicExecutor(job, { signal: new AbortController().signal });
  assert.deepEqual(output.emails, ['owner@example.com']);
  assert.deepEqual(output.amounts, ['$123.45']);
  assert.deepEqual(output.urls, ['https://example.com/report']);
  assert.equal(output.execution, 'deterministic-native-connector');
  const verified = await deterministicExecutor(
    { ...job, capability: 'verify', input: '{"total":2}' },
    { signal: new AbortController().signal },
  );
  assert.equal((verified.checks as Record<string, unknown>).validJson, true);
  assert.match(String(verified.limitation), /no independent factual verification/);
});

test('connector stops cleanly on cancellation and releases its sequence lock', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'central-city-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const abort = new AbortController();
  const events: string[] = [];
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      req.url === '/api/runtime/jobs'
        ? '{"job":null}'
        : '{"ok":true,"heartbeatSeconds":30,"ttlSeconds":90}',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const sequenceFile = join(directory, 'agent.sequence');
  await runConnector({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: 'b'.repeat(64),
    sequenceFile,
    execute: deterministicExecutor,
    signal: abort.signal,
    onEvent(event) {
      events.push(event.type);
      if (event.type === 'connected') abort.abort();
    },
  });
  assert.deepEqual(events, ['connected', 'stopped']);
  const restored = await SequenceStore.acquire(sequenceFile);
  assert.equal(await restored.next(), 1);
  await restored.close();
});
