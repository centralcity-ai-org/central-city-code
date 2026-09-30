import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalModelExecutor, type LocalModelOptions } from '../../connector/local-model.js';
import type { Executor } from '../../connector/index.js';
import type { Job } from '../../shared/types.js';
import { json, requireThat, sha256 } from './protocol.js';

// The shipped executor has no observation hook. This process-exclusive wrapper
// observes fetch without changing its prompts, validation or retry behavior.
let observing = false;
async function withFetch<T>(fetcher: typeof fetch, action: () => Promise<T>) {
  requireThat(!observing, 'Concurrent executor observation is forbidden.');
  observing = true;
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await action();
  } finally {
    globalThis.fetch = original;
    observing = false;
  }
}
export function evaluationJob(input: string, capability: 'research' | 'verify', id: string): Job {
  return {
    id,
    requesterId: 'evaluation',
    providerId: 'evaluation',
    capability,
    input,
    status: 'running',
    acceptance: 'pending',
    output: null,
    createdAt: '',
    updatedAt: '',
    completedAt: null,
    acceptedAt: null,
    costCents: null,
    error: null,
    isDemo: false,
  };
}
export async function executorTemplates(options: LocalModelOptions) {
  const execute = createLocalModelExecutor(options);
  const templates: Record<string, unknown> = {};
  await withFetch(
    async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      templates.current = request;
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    },
    async () => {
      for (const capability of ['research', 'verify'] as const) {
        const source = 'EVALUATION_SOURCE';
        const input =
          capability === 'research'
            ? source
            : JSON.stringify({ source, draft: { claim: 'EVALUATION_DRAFT' } });
        await execute(evaluationJob(input, capability, 'template'), {
          signal: new AbortController().signal,
        }).catch(() => undefined);
        requireThat(templates.current, 'Executor template capture failed.');
        templates[capability] = templates.current;
        delete templates.current;
      }
    },
  );
  return {
    serialized: templates,
    hashes: {
      research_sha256: sha256(json(templates.research)),
      verify_sha256: sha256(json(templates.verify)),
    },
  };
}
export async function executorHash(appRoot: string) {
  return sha256(await readFile(resolve(appRoot, 'connector/local-model.ts')));
}
export interface Observation {
  request: unknown | null;
  raw: string | null;
  raw_complete: boolean;
  http_status: number | null;
  finish_reason: string | null;
  truncated: boolean | null;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number | null } | null;
}
export const emptyObservation = (): Observation => ({
  request: null,
  raw: null,
  raw_complete: false,
  http_status: null,
  finish_reason: null,
  truncated: null,
  usage: null,
});
export type ObservedExecutor = (
  job: Job,
  context: { signal: AbortSignal },
  observation: Observation,
) => ReturnType<Executor>;
export function injectedExecutor(execute: Executor): ObservedExecutor {
  return (job, context) => execute(job, context);
}
export function observedLocalExecutor(options: LocalModelOptions): ObservedExecutor {
  const execute = createLocalModelExecutor(options);
  const allowed = new URL('/v1/chat/completions', options.endpoint).href;
  return async (job, context, observation) => {
    const originalFetch = globalThis.fetch;
    let capture: Promise<void> | undefined;
    return withFetch(
      async (url, init) => {
        requireThat(
          String(url) === allowed && init?.method === 'POST' && init.redirect === 'error',
          'Unexpected model transport.',
        );
        observation.request = JSON.parse(String(init.body));
        const response = await originalFetch(url, init);
        observation.http_status = response.status;
        const copy = response.clone();
        capture = (async () => {
          const reader = copy.body?.getReader();
          if (!reader) return;
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) {
                observation.raw_complete = true;
                break;
              }
              const kept = part.value.subarray(0, Math.max(0, 65536 - length));
              chunks.push(kept);
              length += kept.byteLength;
              if (length >= 65536) {
                observation.truncated = true;
                break;
              }
            }
          } catch {
            /* Partial capture remains evidence; executor owns failure classification. */
          } finally {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
            observation.raw = Buffer.concat(chunks).toString('utf8');
          }
          if (!observation.raw_complete) return;
          try {
            const raw = JSON.parse(observation.raw);
            const reason = raw?.choices?.[0]?.finish_reason;
            observation.finish_reason = typeof reason === 'string' ? reason : null;
            observation.truncated = reason === 'length' ? true : reason === 'stop' ? false : null;
            const usage = raw?.usage;
            if (
              usage &&
              Number.isInteger(usage.prompt_tokens) &&
              usage.prompt_tokens >= 0 &&
              usage.prompt_tokens <= 100000 &&
              Number.isInteger(usage.completion_tokens) &&
              usage.completion_tokens >= 0 &&
              usage.completion_tokens <= 100000 &&
              (usage.total_tokens === undefined ||
                usage.total_tokens === usage.prompt_tokens + usage.completion_tokens)
            ) {
              observation.usage = {
                inputTokens: usage.prompt_tokens,
                outputTokens: usage.completion_tokens,
                totalTokens: usage.total_tokens ?? null,
              };
            }
          } catch {
            /* Invalid JSON remains raw evidence, with unknown usage. */
          }
        })();
        return response;
      },
      async () => {
        try {
          return await execute(job, context);
        } finally {
          await capture;
        }
      },
    );
  };
}
