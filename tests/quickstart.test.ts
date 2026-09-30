import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import {
  DEFAULT_ORIGIN,
  parseOptions,
  runQuickstart,
  formatResult,
} from '../examples/quickstart/index.mjs';

test('quickstart defaults locally and refuses ambiguous or credential-bearing options', () => {
  assert.equal(parseOptions([]).origin, DEFAULT_ORIGIN);
  for (const args of [
    ['--origin'],
    ['--unknown', 'x'],
    ['--origin', 'https://user:secret@example.com'],
    ['--origin', 'http://example.com'],
    ['--origin', 'https://example.com/path'],
    ['--idempotency-key', 'weak'],
    ['--origin', 'https://example.com', '--origin', 'https://other.example'],
  ])
    assert.throws(() => parseOptions(args));
});

test('quickstart creates one claimable local agent and retry does not create or reissue secrets', async (t) => {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  await app.listen({ host: '127.0.0.1', port: 0 });
  const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const options = { origin, idempotencyKey: randomUUID() };
  const first = await runQuickstart(options);
  assert.ok(first.claimUrl?.startsWith(`${origin}/#claim=ccclaim_`));
  assert.equal(first.replayed, false);
  const output = formatResult(first);
  assert.equal((output.match(/ccclaim_/g) ?? []).length, 1);
  assert.ok(!/enrollment_code|runtime_token|claim_token|ccrt_/.test(output));
  assert.match(output, /No automatic time expiry/);
  const again = await runQuickstart(options);
  assert.equal(again.agentId, first.agentId);
  assert.equal(again.claimUrl, null);
  assert.equal(again.replayed, true);
  const cli = fileURLToPath(new URL('../examples/quickstart/cli.mjs', import.meta.url));
  const execution = await promisify(execFile)(process.execPath, [
    cli,
    '--origin',
    origin,
    '--idempotency-key',
    options.idempotencyKey,
  ]);
  assert.match(execution.stdout, /Already applied/);
  assert.ok(!execution.stdout.includes('ccclaim_'));
  assert.equal(execution.stderr, '');
  assert.match(formatResult(again), /not issued again/);
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'x-city-request': '1' },
    payload: { name: 'Quickstart Owner', password: 'Synthetic-test-only-password-2026' },
  });
  assert.equal(registered.statusCode, 201);
  const cookie = registered.headers['set-cookie'];
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/agents/claim',
    headers: {
      cookie: Array.isArray(cookie) ? cookie[0]!.split(';')[0]! : String(cookie).split(';')[0]!,
      'x-city-request': '1',
    },
    payload: { claim_token: new URL(first.claimUrl!).hash.slice('#claim='.length) },
  });
  assert.equal(claimed.statusCode, 200);
});
