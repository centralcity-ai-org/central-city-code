import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../server/app.js';
import { signedHeaders } from '../connector/signing.js';
import { requestPeerJob, readRequestedJob } from '../connector/index.js';

test(
  'a separate native connector process completes a real authorized task over HTTP',
  { timeout: 25_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'central-city-process-'));
    const app = await createApp({ dataDir: 'memory://', startWorkers: false });
    let stopChild = async () => {};
    t.after(async () => {
      await stopChild();
      await app.close();
      await rm(directory, { recursive: true, force: true });
    });
    const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
    const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
    const registration = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers,
      payload: { name: 'Connector process operator', password: 'Synthetic testing password 2026!' },
    });
    assert.ok([200, 201].includes(registration.statusCode), registration.body);
    const session = registration.cookies.find((cookie) => cookie.name === 'cc_session');
    assert.ok(session);
    const owner = { ...headers, cookie: `cc_session=${session.value}` };
    const create = async (name: string, capability: 'research' | 'extract') => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agents',
        headers: owner,
        payload: {
          name,
          description: 'Synthetic process verification',
          mode: 'external',
          capability,
        },
      });
      assert.ok([200, 201].includes(response.statusCode), response.body);
      return response.json();
    };
    const requester = await create('Test requester', 'research');
    const provider = await create('Process extractor', 'extract');
    const heartbeatBody = JSON.stringify({ sequence: 1 });
    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/runtime/heartbeat',
      headers: signedHeaders(requester.token, 'POST', '/api/runtime/heartbeat', heartbeatBody),
      payload: heartbeatBody,
    });
    assert.equal(heartbeat.statusCode, 200, heartbeat.body);
    const configPath = join(directory, 'private.json');
    await writeFile(
      configPath,
      JSON.stringify({ baseUrl, token: provider.token, sequenceFile: 'agent.sequence' }),
      { mode: 0o600 },
    );
    const root = fileURLToPath(new URL('../', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', resolve(root, 'connector/cli.ts'), 'connect', configPath],
      {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + String(chunk)).slice(-16_384);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-8_192);
    });
    stopChild = async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await Promise.race([
          new Promise((resolveExit) => child.once('exit', resolveExit)),
          sleep(2_000),
        ]);
      }
    };
    const waitFor = async (condition: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!condition()) {
        if (child.exitCode !== null)
          throw new Error('Connector process exited before the expected event.');
        if (Date.now() > deadline) throw new Error('Connector process event timed out.');
        await sleep(50);
      }
    };
    await waitFor(() => stdout.includes('connected'));
    const connection = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: owner,
      payload: { fromAgentId: requester.agent.id, toAgentId: provider.agent.id },
    });
    assert.ok([200, 201].includes(connection.statusCode), connection.body);
    const input = 'Client: Northwind\nRevenue: $123.45\nContact: owner@example.com';
    const submitted = await app.inject({
      method: 'POST',
      url: '/api/jobs',
      headers: owner,
      payload: {
        requesterId: requester.agent.id,
        providerId: provider.agent.id,
        input,
        idempotencyKey: 'native-process-job',
      },
    });
    assert.ok([200, 201].includes(submitted.statusCode), submitted.body);
    await waitFor(() => stdout.includes(`completed job=${submitted.json().job.id}`));
    const snapshot = (await app.inject({ url: '/api/snapshot', headers: owner })).json();
    assert.equal(
      snapshot.agents.find((agent: { id: string }) => agent.id === provider.agent.id).status,
      'online',
    );
    const job = snapshot.jobs.find((item: { id: string }) => item.id === submitted.json().job.id);
    assert.equal(job.status, 'completed');
    assert.equal(job.acceptance, 'pending');
    assert.deepEqual(job.output.emails, ['owner@example.com']);
    assert.deepEqual(job.output.amounts, ['$123.45']);
    assert.equal(job.output.execution, 'deterministic-native-connector');
    const hostedResponse = await app.inject({
      method: 'POST',
      url: '/api/agents',
      headers: owner,
      payload: {
        name: 'Peer verifier',
        description: 'Deterministic structural check',
        mode: 'hosted',
        capability: 'verify',
      },
    });
    assert.ok([200, 201].includes(hostedResponse.statusCode), hostedResponse.body);
    const hosted = hostedResponse.json().agent;
    const peerGrant = await app.inject({
      method: 'POST',
      url: '/api/connections',
      headers: owner,
      payload: { fromAgentId: requester.agent.id, toAgentId: hosted.id },
    });
    assert.ok([200, 201].includes(peerGrant.statusCode), peerGrant.body);
    await app.city.tick();
    const request = await requestPeerJob(
      { baseUrl, token: requester.token },
      {
        providerId: hosted.id,
        input: JSON.stringify(job.output),
        idempotencyKey: 'native-sdk-handoff',
      },
    );
    await app.city.tick();
    await app.city.tick();
    const inspected = await readRequestedJob({ baseUrl, token: requester.token }, request.id);
    assert.equal(inspected.status, 'completed');
    assert.equal(inspected.acceptance, 'pending');
    assert.equal(inspected.requesterId, requester.agent.id);
    assert.equal(inspected.providerId, hosted.id);
    const logs = stdout + stderr;
    assert.ok(!logs.includes(provider.token), 'connector never writes the scoped token to logs');
    assert.ok(!logs.includes(input), 'connector never writes task contents to logs');
  },
);
