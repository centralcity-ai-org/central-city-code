import { setTimeout as sleep } from 'node:timers/promises';
import type { Job } from '../shared/types.js';
import { signedHeaders } from './signing.js';
import { SequenceStore } from './sequence.js';
import { hostedAppHeaders, type HostedAppConfig } from './hosted-config.js';

export type Executor = (
  job: Readonly<Job>,
  context: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;
export interface ConnectorOptions {
  baseUrl: string;
  token: string;
  hostedApp?: HostedAppConfig;
  sequenceFile: string;
  execute: Executor;
  signal?: AbortSignal;
  onEvent?: (event: {
    type: 'connected' | 'completed' | 'failed' | 'retrying' | 'rejected' | 'stopped';
    jobId?: string;
  }) => void;
}
export class RuntimeError extends Error {
  constructor(readonly status: number) {
    super(`Central City runtime returned HTTP ${status}.`);
  }
}
class ExecutorDeadlineError extends Error {}
/** An explicit pure-compute failure; report once under the current lease rather than rerun inference. */
export class ExecutorFailureError extends Error {
  constructor(
    readonly reason:
      'invalid-input' | 'invalid-output' | 'execution-timeout' | 'runtime-unavailable',
  ) {
    super('The executor reported a bounded failure.');
  }
}

export function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid runtime origin.');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('baseUrl must be an origin without credentials, path, query, or fragment.');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('Use HTTPS; HTTP is allowed only for the local development server.');
  }
  return url;
}

export async function runtimeRequest<T>(
  config: Pick<ConnectorOptions, 'baseUrl' | 'token' | 'hostedApp'>,
  method: 'GET' | 'POST',
  pathname: string,
  data?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const origin = validateBaseUrl(config.baseUrl);
  if (
    !/^\/api\/runtime\/(?:heartbeat|jobs|requests|jobs\/[a-zA-Z0-9_-]{1,100}\/(?:result|failure)|requests\/[a-zA-Z0-9_-]{1,100})$/.test(
      pathname,
    )
  ) {
    throw new Error('Invalid runtime endpoint.');
  }
  const target = new URL(pathname, origin);
  if (target.origin !== origin.origin || target.pathname !== pathname)
    throw new Error('Invalid runtime endpoint.');
  const protectionHeaders = hostedAppHeaders(config.hostedApp, config.baseUrl, target);
  const body = data === undefined ? '' : JSON.stringify(data);
  if (Buffer.byteLength(body, 'utf8') > 64 * 1024)
    throw new Error('Runtime request exceeds 64 KiB.');
  let response: Response;
  try {
    response = await fetch(target, {
      method,
      headers: { ...signedHeaders(config.token, method, pathname, body), ...protectionHeaders },
      body: method === 'POST' ? body : undefined,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
  } catch {
    // Transport errors and abort reasons can contain private headers or response details.
    throw new Error('Runtime request failed.');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new RuntimeError(response.status);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing runtime response body.');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 96 * 1024) throw new Error('Runtime response exceeded limit.');
      chunks.push(value);
    }
  } catch {
    throw new Error('Runtime response failed or exceeded limit.');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    throw new Error('Invalid runtime response.');
  }
}

export function serializeOutput(output: unknown): Record<string, unknown> {
  if (!output || typeof output !== 'object' || Array.isArray(output))
    throw new Error('Executor output must be a JSON object.');
  const serialized = JSON.stringify(output);
  if (Buffer.byteLength(serialized, 'utf8') > 32 * 1024)
    throw new Error('Executor output exceeds 32 KiB.');
  return JSON.parse(serialized) as Record<string, unknown>;
}

/** Request a granted, zero-cost hosted peer. The server derives requester identity from the token. */
export async function requestPeerJob(
  config: Pick<ConnectorOptions, 'baseUrl' | 'token' | 'hostedApp'>,
  request: { providerId: string; input: string; idempotencyKey: string },
  signal?: AbortSignal,
): Promise<Job> {
  const response = await runtimeRequest<{ job: Job }>(
    config,
    'POST',
    '/api/runtime/requests',
    request,
    signal,
  );
  return response.job;
}

/** Read only work requested by this credential, subject to the live connection grant. */
export async function readRequestedJob(
  config: Pick<ConnectorOptions, 'baseUrl' | 'token' | 'hostedApp'>,
  jobId: string,
  signal?: AbortSignal,
): Promise<Job> {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(jobId)) throw new Error('Invalid job identity.');
  const response = await runtimeRequest<{ job: Job }>(
    config,
    'GET',
    `/api/runtime/requests/${jobId}`,
    undefined,
    signal,
  );
  return response.job;
}

/** Runs one external agent until aborted, authentication fails, or local sequence storage fails. */
export async function runConnector(options: ConnectorOptions): Promise<void> {
  const origin = validateBaseUrl(options.baseUrl);
  hostedAppHeaders(options.hostedApp, options.baseUrl, origin);
  if (typeof options.token !== 'string' || options.token.length < 32 || options.token.length > 512)
    throw new Error('Invalid scoped runtime token.');
  const sequence = await SequenceStore.acquire(options.sequenceFile);
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const emit = (
    type: Parameters<NonNullable<ConnectorOptions['onEvent']>>[0]['type'],
    jobId?: string,
  ) => options.onEvent?.({ type, jobId });
  let fatal: unknown;
  const stop = (error: unknown) => {
    fatal ??= error;
    controller.abort();
  };
  const pause = async (ms: number) => {
    await sleep(ms, undefined, { signal });
  };
  const heartbeat = async () => {
    let connected = false;
    let backoff = 1_000;
    while (!signal.aborted) {
      // A storage error is fatal. A persisted number may be skipped after a network failure.
      const next = await sequence.next();
      try {
        await runtimeRequest(options, 'POST', '/api/runtime/heartbeat', { sequence: next }, signal);
        if (!connected) {
          connected = true;
          emit('connected');
        }
        backoff = 1_000;
        await pause(30_000);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof RuntimeError && [400, 401, 403, 409].includes(error.status))
          throw error;
        emit('retrying');
        await pause(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  };
  const jobs = async () => {
    let backoff = 2_000;
    while (!signal.aborted) {
      try {
        const claimed = await runtimeRequest<{ job: Job | null; leaseToken?: string }>(
          options,
          'GET',
          '/api/runtime/jobs',
          undefined,
          signal,
        );
        if (claimed.job) {
          const { job, leaseToken } = claimed;
          if (
            !leaseToken ||
            typeof job.id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,100}$/.test(job.id) ||
            typeof job.input !== 'string' ||
            job.input.length > 12_000
          ) {
            throw new Error('Malformed job response.');
          }
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(35_000)]);
          let outcome: {
            suffix: 'result' | 'failure';
            payload: Record<string, unknown>;
            event: 'completed' | 'failed';
          };
          try {
            const output = serializeOutput(
              await executeWithDeadline(options.execute, job, deadline),
            );
            outcome = { suffix: 'result', payload: { leaseToken, output }, event: 'completed' };
          } catch (error) {
            if (!(error instanceof ExecutorFailureError)) throw error;
            signal.throwIfAborted();
            outcome = {
              suffix: 'failure',
              payload: { leaseToken, reason: error.reason },
              event: 'failed',
            };
          }
          // Retry delivery of the exact result/failure, never rerun inference here.
          for (let attempt = 0; ; attempt++) {
            try {
              await runtimeRequest(
                options,
                'POST',
                `/api/runtime/jobs/${job.id}/${outcome.suffix}`,
                outcome.payload,
                signal,
              );
              emit(outcome.event, job.id);
              break;
            } catch (error) {
              if (signal.aborted) return;
              if (error instanceof RuntimeError && [400, 404, 409, 422].includes(error.status)) {
                emit('rejected', job.id);
                break;
              }
              if (error instanceof RuntimeError && [401, 403].includes(error.status)) throw error;
              if (attempt >= 2) throw error;
              await pause(1_000 * (attempt + 1));
            }
          }
        }
        backoff = 2_000;
        await pause(2_000);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof ExecutorDeadlineError) throw error;
        if (error instanceof RuntimeError && [401, 403].includes(error.status)) throw error;
        emit('retrying');
        await pause(backoff);
        backoff = Math.min(backoff * 2, 15_000);
      }
    }
  };
  try {
    await Promise.allSettled([heartbeat().catch(stop), jobs().catch(stop)]);
    if (fatal && !options.signal?.aborted) throw fatal;
  } finally {
    controller.abort();
    await sequence.close();
    emit('stopped');
  }
}

async function executeWithDeadline(
  execute: Executor,
  job: Job,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    abort = () =>
      reject(
        new ExecutorDeadlineError(
          'Executor deadline reached. Stop this process before reconnecting an unresponsive executor.',
        ),
      );
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    return await Promise.race([execute(Object.freeze({ ...job }), { signal }), timeout]);
  } finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}
