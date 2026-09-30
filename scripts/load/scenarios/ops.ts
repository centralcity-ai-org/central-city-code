import { randomUUID } from 'node:crypto';
import type { LoadClient, OwnerSession, Recorder, RouteSummary, Totals } from '../client.js';
import { heartbeat, type AgentHandle, type IpPool } from '../seed.js';
import type { InstrumentStats } from '../instrument.js';
import type { LatencySummary } from '../histogram.js';

export interface ServerStats {
  db: InstrumentStats;
  blobs: Record<string, number>;
  eventLoopDelayMs: Omit<LatencySummary, 'count'>;
  /** Server process CPU (user+system) as a percentage of one core since the last reset. */
  cpuPercent: number;
  memory: { rssMb: number };
}
export interface ServerHandle {
  port: number;
  reset(): Promise<void>;
  stats(operatorIds?: string[]): Promise<ServerStats>;
  stop(): Promise<void>;
}
export interface Context {
  client: LoadClient;
  ips: IpPool;
  runId: string;
  limits: 'on' | 'off';
  server: ServerHandle;
  options: Record<string, string>;
  log(message: string): void;
}
export interface ScenarioResult {
  id: string;
  title: string;
  metrics: Record<string, unknown>;
  requests: { elapsedSeconds: number; routes: RouteSummary[]; totals: Totals };
  server: ServerStats;
  tables?: Array<{ title: string; columns: string[]; rows: Array<Array<string | number>> }>;
  notes?: string[];
}

export const numberOption = (ctx: Context, key: string, fallback: number): number => {
  const raw = ctx.options[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a number.`);
  return value;
};

export function submitJob(
  client: LoadClient,
  owner: OwnerSession,
  requester: AgentHandle,
  provider: AgentHandle,
  input = `Synthetic load input ${randomUUID()}`,
  idempotencyKey = randomUUID(),
  expect?: readonly number[],
) {
  return client.send({
    method: 'POST',
    path: '/api/jobs',
    route: 'POST /api/jobs',
    body: { requesterId: requester.id, providerId: provider.id, input, idempotencyKey },
    ip: owner.ip,
    owner,
    ...(expect ? { expect } : {}),
  });
}

export function claim(client: LoadClient, agent: AgentHandle) {
  return client.send({
    method: 'GET',
    path: '/api/runtime/jobs',
    route: 'GET /api/runtime/jobs',
    ip: agent.ip,
    runtimeToken: agent.token!,
  });
}

export function submitResult(
  client: LoadClient,
  agent: AgentHandle,
  jobId: string,
  leaseToken: string,
  output: Record<string, unknown>,
  expect?: readonly number[],
) {
  return client.send({
    method: 'POST',
    path: `/api/runtime/jobs/${jobId}/result`,
    route: 'POST /api/runtime/jobs/:id/result',
    body: { leaseToken, output },
    ip: agent.ip,
    runtimeToken: agent.token!,
    ...(expect ? { expect } : {}),
  });
}

export function accept(client: LoadClient, owner: OwnerSession, jobId: string) {
  return client.send({
    method: 'POST',
    path: `/api/jobs/${jobId}/accept`,
    route: 'POST /api/jobs/:id/accept',
    body: {},
    ip: owner.ip,
    owner,
  });
}

export function snapshot(client: LoadClient, owner: OwnerSession) {
  return client.send({
    method: 'GET',
    path: '/api/snapshot',
    route: 'GET /api/snapshot',
    ip: owner.ip,
    owner,
  });
}

export function runtimeRequest(client: LoadClient, agent: AgentHandle, provider: AgentHandle) {
  return client.send({
    method: 'POST',
    path: '/api/runtime/requests',
    route: 'POST /api/runtime/requests',
    body: {
      providerId: provider.id,
      input: `Synthetic runtime request ${randomUUID()}`,
      idempotencyKey: randomUUID(),
    },
    ip: agent.ip,
    runtimeToken: agent.token!,
  });
}

export function runtimeRequestStatus(client: LoadClient, agent: AgentHandle, jobId: string) {
  return client.send({
    method: 'GET',
    path: `/api/runtime/requests/${jobId}`,
    route: 'GET /api/runtime/requests/:id',
    ip: agent.ip,
    runtimeToken: agent.token!,
  });
}

export const syntheticOutput = (padBytes = 0) => ({
  summary: 'Synthetic load-test result.',
  ...(padBytes ? { note: 'x'.repeat(padBytes) } : {}),
});

/** Keeps external agents reachable (presence TTL is 90 s) until `until`. */
export async function keepAlive(
  client: LoadClient,
  agents: AgentHandle[],
  until: () => boolean,
  intervalMs = 25_000,
): Promise<void> {
  const next = new Map(agents.map((agent) => [agent.id, Date.now() + intervalMs * Math.random()]));
  while (!until()) {
    const now = Date.now();
    for (const agent of agents)
      if (next.get(agent.id)! <= now) {
        next.set(agent.id, now + intervalMs);
        void heartbeat(client, agent);
      }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * One full job lifecycle on one owner: owner submits → provider claims → provider submits a
 * result → owner accepts. Returns the number of steps that succeeded (4 = full cycle).
 */
export async function jobCycle(
  client: LoadClient,
  owner: OwnerSession,
  requester: AgentHandle,
  provider: AgentHandle,
  outputPad = 0,
  seenClaims?: Set<string>,
  duplicates?: { claims: number },
): Promise<number> {
  const submitted = await submitJob(client, owner, requester, provider);
  if (submitted.status !== 201) return 0;
  const jobId: string = submitted.body.job.id;
  let lease: string | undefined;
  for (let attempt = 0; attempt < 3 && !lease; attempt++) {
    const claimed = await claim(client, provider);
    if (claimed.status !== 200) return 1;
    if (claimed.body.job) {
      if (seenClaims && duplicates) {
        if (seenClaims.has(claimed.body.job.id)) duplicates.claims++;
        seenClaims.add(claimed.body.job.id);
      }
      if (claimed.body.job.id !== jobId) {
        // An older queued job for this provider (e.g. from a refused step) — finish it too.
        await submitResult(
          client,
          provider,
          claimed.body.job.id,
          claimed.body.leaseToken,
          syntheticOutput(outputPad),
        );
        continue;
      }
      lease = claimed.body.leaseToken;
    }
  }
  if (!lease) return 1;
  const result = await submitResult(client, provider, jobId, lease, syntheticOutput(outputPad));
  if (result.status !== 200) return 2;
  const accepted = await accept(client, owner, jobId);
  return accepted.status === 200 ? 4 : 3;
}

export function withRecorder<T>(client: LoadClient, recorder: Recorder, action: () => Promise<T>) {
  const previous = client.recorder;
  client.recorder = recorder;
  return action().finally(() => {
    recorder.stop();
    client.recorder = previous;
  });
}
