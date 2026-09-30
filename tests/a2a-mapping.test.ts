import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Job } from '../shared/types.js';
import {
  A2A_PIN,
  A2A_LIMITS,
  A2AMappingError,
  parseA2AIntent,
  projectNativeJob,
  createTaskResponse,
  type MappingErrorCode,
} from '../protocol/a2a.js';

const readFixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../protocol/fixtures/${name}.json`, import.meta.url), 'utf8'));
const selection = { version: '1.0', binding: 'JSONRPC' };
const wire = { ...selection, taskId: 'wire-task-fixture-1', contextId: 'wire-context-fixture-1' };
const failsWith = (code: MappingErrorCode) => (error: unknown) =>
  error instanceof A2AMappingError && error.code === code;

test('A2A pin distinguishes the verified release from the wire version and never silently downgrades', () => {
  assert.equal(A2A_PIN.release, '1.0.0');
  assert.equal(A2A_PIN.wireVersion, '1.0');
  for (const version of [undefined, '', '0.3', '1.0.0', '1.1', 'latest', '1.0 ']) {
    assert.throws(
      () => parseA2AIntent('{}', { ...selection, version }),
      failsWith('UNSUPPORTED_VERSION'),
    );
  }
  for (const binding of ['HTTP+JSON', 'GRPC', 'jsonrpc']) {
    assert.throws(
      () => parseA2AIntent('{}', { ...selection, binding }),
      failsWith('UNSUPPORTED_BINDING'),
    );
  }
});

test('A2A literal send fixture produces untrusted text intent without inventing identity or idempotency authority', async () => {
  const request = await readFixture('a2a-send-message');
  assert.deepEqual(parseA2AIntent(JSON.stringify(request), selection), {
    method: 'SendMessage',
    rpcId: 'rpc-fixture-1',
    messageId: 'message-fixture-1',
    input: 'Extract the project name from this supplied text: Project Lantern.',
  });
  const first = parseA2AIntent(JSON.stringify(request), selection);
  request.id = 'different-rpc-attempt';
  const repeat = parseA2AIntent(JSON.stringify(request), selection);
  assert.equal(first.method, 'SendMessage');
  assert.equal(repeat.method, 'SendMessage');
  // Parsing does not execute, deduplicate, authenticate or grant anything.
  assert.equal('providerId' in repeat, false);
  assert.equal('idempotencyKey' in repeat, false);
});

test('A2A unsupported tenant, metadata, context, continuation and protocol features fail closed', async () => {
  const original = await readFixture('a2a-send-message');
  const mutations = [
    (request: typeof original) => {
      request.params.tenant = 'another-owner';
    },
    (request: typeof original) => {
      request.params.metadata = { requesterId: 'admin', accepted: true };
    },
    (request: typeof original) => {
      request.params.message.metadata = { capabilities: ['transfer'] };
    },
    (request: typeof original) => {
      request.params.message.taskId = 'terminal-task';
    },
    (request: typeof original) => {
      request.params.message.contextId = 'other-context';
    },
    (request: typeof original) => {
      request.params.message.extensions = ['https://example.invalid/privilege'];
    },
    (request: typeof original) => {
      request.params.message.role = 'ROLE_AGENT';
    },
    (request: typeof original) => {
      request.params.message.kind = 'message';
    },
    (request: typeof original) => {
      request.params.configuration.returnImmediately = false;
    },
    (request: typeof original) => {
      delete request.params.configuration;
    },
    (request: typeof original) => {
      request.params.configuration.taskPushNotificationConfig = { url: 'http://127.0.0.1/admin' };
    },
    (request: typeof original) => {
      request.params.configuration.acceptedOutputModes = ['text/plain'];
    },
  ];
  for (const mutate of mutations) {
    const request = structuredClone(original);
    mutate(request);
    assert.throws(
      () => parseA2AIntent(JSON.stringify(request), selection),
      failsWith('UNSUPPORTED_PARAMETERS'),
    );
  }
});

test('A2A file URLs, raw/data parts, mixed oneof content and multiple parts cannot enter native text execution', async () => {
  const request = await readFixture('a2a-send-message');
  for (const parts of [
    [{ url: 'http://169.254.169.254/latest/meta-data/' }],
    [{ raw: 'dGVzdA==' }],
    [{ data: { action: 'execute' } }],
    [{ text: 'okay', url: 'https://example.invalid' }],
    [{ text: 'a' }, { text: 'b' }],
    [],
    [{ text: '   ' }],
    [{ text: 'x'.repeat(A2A_LIMITS.inputCharacters + 1) }],
  ]) {
    request.params.message.parts = parts;
    assert.throws(
      () => parseA2AIntent(JSON.stringify(request), selection),
      failsWith('UNSUPPORTED_PARAMETERS'),
    );
  }
});

test('A2A raw size is bounded in bytes before JSON parsing; malformed, batch and notification requests reject', async () => {
  assert.throws(
    () => parseA2AIntent('😀'.repeat(A2A_LIMITS.requestBytes / 4 + 1), selection),
    failsWith('PAYLOAD_TOO_LARGE'),
  );
  assert.throws(() => parseA2AIntent('{', selection), failsWith('INVALID_JSON'));
  for (const raw of [
    'null',
    '[]',
    '{}',
    '{"jsonrpc":"2.0","method":"GetTask","params":{"id":"t"}}',
  ]) {
    assert.throws(() => parseA2AIntent(raw, selection), failsWith('INVALID_REQUEST'));
  }
  const request = await readFixture('a2a-send-message');
  for (const method of [
    'message/send',
    'tasks/get',
    'SendStreamingMessage',
    'ListTasks',
    'AcceptTask',
    'GetExtendedAgentCard',
  ]) {
    request.method = method;
    assert.throws(
      () => parseA2AIntent(JSON.stringify(request), selection),
      failsWith('UNSUPPORTED_OPERATION'),
    );
  }
});

test('A2A GetTask and CancelTask remain separate intent types; task history and request IDs remain bounded', () => {
  for (const method of ['GetTask', 'CancelTask'] as const) {
    const request = { jsonrpc: '2.0', id: 7, method, params: { id: 'wire-task-1' } };
    assert.deepEqual(parseA2AIntent(JSON.stringify(request), selection), {
      method,
      rpcId: 7,
      taskId: 'wire-task-1',
    });
    assert.throws(
      () =>
        parseA2AIntent(JSON.stringify({ ...request, id: Number.MAX_SAFE_INTEGER + 1 }), selection),
      failsWith('INVALID_REQUEST'),
    );
    assert.throws(
      () =>
        parseA2AIntent(JSON.stringify({ ...request, params: { id: '../other-owner' } }), selection),
      failsWith('UNSUPPORTED_PARAMETERS'),
    );
  }
  assert.throws(
    () =>
      parseA2AIntent(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 8,
          method: 'GetTask',
          params: { id: 't', historyLength: 1 },
        }),
        selection,
      ),
    failsWith('UNSUPPORTED_PARAMETERS'),
  );
});

test('A2A completed task matches independently authored fixture and never exports private native fields', async () => {
  const job = (await readFixture('native-completed-job')) as Job;
  const expected = await readFixture('a2a-completed-task');
  const task = projectNativeJob(job, wire);
  assert.deepEqual(task, expected);
  const serialized = JSON.stringify(task);
  for (const forbidden of [
    'native-job-fixture',
    'private-requester',
    'private-provider',
    'costCents',
    'acceptance',
    'acceptedAt',
    'isDemo',
    job.input,
  ])
    assert.equal(serialized.includes(forbidden), false);
  task.artifacts![0].parts[0].data.project = 'modified-copy';
  assert.equal(job.output?.project, 'Lantern');
});

test('A2A completion remains independent of owner acceptance, including the status timestamp', async () => {
  const job = (await readFixture('native-completed-job')) as Job;
  const before = projectNativeJob(job, wire);
  const accepted: Job = {
    ...job,
    acceptance: 'accepted',
    acceptedAt: '2026-09-25T12:30:00.000Z',
    updatedAt: '2026-09-25T12:30:00.000Z',
  };
  assert.deepEqual(projectNativeJob(accepted, wire), before);
  assert.equal(job.acceptance, 'pending');
});

test('A2A execution projection maps each native state without exposing incomplete artifacts or internal errors', async () => {
  const job = (await readFixture('native-completed-job')) as Job;
  const states = [
    ['queued', 'TASK_STATE_SUBMITTED'],
    ['running', 'TASK_STATE_WORKING'],
    ['failed', 'TASK_STATE_FAILED'],
    ['canceled', 'TASK_STATE_CANCELED'],
  ] as const;
  for (const [status, expected] of states) {
    const task = projectNativeJob({ ...job, status, error: 'secret internal error' }, wire);
    assert.equal(task.status.state, expected);
    assert.equal('artifacts' in task, false);
    assert.equal(JSON.stringify(task).includes('secret'), false);
  }
});

test('A2A native projection rejects inconsistent terminal jobs and non-JSON or excessive output', async () => {
  const job = (await readFixture('native-completed-job')) as Job;
  for (const changes of [
    { completedAt: null },
    { updatedAt: 'not-a-date' },
    { output: null },
    { output: { score: Infinity } },
    { output: { unsupported: undefined } },
  ]) {
    assert.throws(
      () => projectNativeJob({ ...job, ...changes }, wire),
      failsWith('INVALID_NATIVE_JOB'),
    );
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => projectNativeJob({ ...job, output: cyclic }, wire),
    failsWith('INVALID_NATIVE_JOB'),
  );
  assert.throws(
    () => projectNativeJob({ ...job, output: { text: 'x'.repeat(A2A_LIMITS.outputBytes) } }, wire),
    failsWith('PAYLOAD_TOO_LARGE'),
  );
  assert.throws(
    () => projectNativeJob(job, { ...wire, version: '0.3' }),
    failsWith('UNSUPPORTED_VERSION'),
  );
});

test('A2A response wrappers preserve operation shape and cannot turn a cancellation request into confirmed cancellation', async () => {
  const job = (await readFixture('native-completed-job')) as Job;
  const task = projectNativeJob(job, wire);
  const send = parseA2AIntent(JSON.stringify(await readFixture('a2a-send-message')), selection);
  assert.deepEqual(createTaskResponse(send, task), {
    jsonrpc: '2.0',
    id: 'rpc-fixture-1',
    result: { task },
  });
  assert.deepEqual(createTaskResponse({ method: 'GetTask', rpcId: 2, taskId: task.id }, task), {
    jsonrpc: '2.0',
    id: 2,
    result: task,
  });
  const cancel = { method: 'CancelTask' as const, rpcId: 3, taskId: task.id };
  assert.throws(() => createTaskResponse(cancel, task), failsWith('CANCEL_NOT_CONFIRMED'));
  assert.equal(job.status, 'completed');
  const canceled = projectNativeJob({ ...job, status: 'canceled', output: null }, wire);
  assert.deepEqual(createTaskResponse(cancel, canceled), {
    jsonrpc: '2.0',
    id: 3,
    result: canceled,
  });
  assert.throws(
    () => createTaskResponse({ ...cancel, taskId: 'other-task' }, canceled),
    failsWith('INVALID_REQUEST'),
  );
});
