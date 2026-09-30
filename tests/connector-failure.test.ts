import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecutorFailureError, runConnector } from '../connector/index.js';

test(
  'connector retries failure delivery without repeating inference or exposing error detail',
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'city-failure-'));
    const controller = new AbortController();
    let executions = 0;
    const received: unknown[] = [];
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/runtime/heartbeat') response.end('{"ok":true}');
      else if (request.url === '/api/runtime/jobs')
        response.end(
          JSON.stringify({
            job: { id: 'synthetic-job', input: 'Synthetic source', capability: 'research' },
            leaseToken: 'synthetic-lease-token-1234',
          }),
        );
      else if (request.url === '/api/runtime/jobs/synthetic-job/failure') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.statusCode = received.length === 1 ? 503 : 200;
        response.end('{}');
      } else {
        response.statusCode = 404;
        response.end('{}');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    try {
      await runConnector({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: 'synthetic-token-'.repeat(4),
        sequenceFile: join(directory, 'sequence'),
        signal: controller.signal,
        execute: async () => {
          executions++;
          const error = new ExecutorFailureError('invalid-output');
          error.message = 'Untrusted model text must not be transmitted in failure details';
          throw error;
        },
        onEvent: (event) => {
          if (event.type === 'failed') controller.abort();
        },
      });
      assert.equal(executions, 1);
      assert.equal(received.length, 2);
      assert.deepEqual(received[0], {
        leaseToken: 'synthetic-lease-token-1234',
        reason: 'invalid-output',
      });
      assert.deepEqual(received[1], received[0]);
    } finally {
      controller.abort();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
