import { Recorder, jitter, sleep } from '../client.js';
import { heartbeat, type AgentHandle, type OwnerWorld } from '../seed.js';
import {
  accept,
  claim,
  numberOption,
  runtimeRequest,
  runtimeRequestStatus,
  snapshot,
  submitJob,
  submitResult,
  syntheticOutput,
  withRecorder,
  type Context,
  type ScenarioResult,
} from './ops.js';

/**
 * S1 runtime steady state. Every external agent runs a connector-like loop (poll for work,
 * heartbeat, occasional native request to a hosted provider); every owner submits jobs,
 * accepts results and polls the snapshot. Client-side budgets keep each workspace within the
 * default active-job caps so both limit profiles offer the same valid load.
 */
export async function runS1(ctx: Context, worlds: OwnerWorld[]): Promise<ScenarioResult> {
  const durationMs = numberOption(ctx, 's1-seconds', 40) * 1000;
  const pollMs = numberOption(ctx, 's1-poll-ms', 2000);
  const submitMs = numberOption(ctx, 's1-submit-ms', 1000);
  const requestMs = numberOption(ctx, 's1-request-ms', 8000);
  const maxActivePerOwner = 6;
  const recorder = new Recorder();
  const deadline = Date.now() + durationMs;
  const running = () => Date.now() < deadline;
  const counters = {
    submitted: 0,
    claimed: 0,
    completed: 0,
    accepted: 0,
    hostedRequests: 0,
    hostedCompleted: 0,
    duplicateClaims: 0,
    duplicateJobIds: 0,
  };
  const claimedIds = new Set<string>();
  const submittedIds = new Set<string>();
  await ctx.server.reset();
  ctx.log(`S1 steady state: ${worlds.length} owners, ${durationMs / 1000}s`);

  await withRecorder(ctx.client, recorder, async () => {
    const loops: Promise<void>[] = [];
    for (const world of worlds) {
      const activePairs = new Set<string>();
      const acceptQueue: string[] = [];
      const hostedBusy = new Set<string>();
      const providerOf = new Map(world.pairs.map(([from, to]) => [to.id, from.id]));

      loops.push(
        (async () => {
          await sleep(Math.random() * submitMs);
          let nextSnapshot = Date.now() + jitter(5000);
          while (running()) {
            while (acceptQueue.length) {
              const response = await accept(ctx.client, world.session, acceptQueue.shift()!);
              if (response.status === 200) counters.accepted++;
            }
            const free = world.pairs.filter(([from]) => !activePairs.has(from.id));
            if (free.length && activePairs.size < maxActivePerOwner) {
              const [from, to] = free[Math.floor(Math.random() * free.length)]!;
              activePairs.add(from.id);
              const response = await submitJob(ctx.client, world.session, from, to);
              if (response.status === 201) {
                counters.submitted++;
                // Every submission uses a fresh idempotency key: a repeated id is a duplicate.
                if (submittedIds.has(response.body.job.id)) counters.duplicateJobIds++;
                submittedIds.add(response.body.job.id);
              } else activePairs.delete(from.id);
            }
            if (Date.now() >= nextSnapshot) {
              nextSnapshot = Date.now() + jitter(5000);
              await snapshot(ctx.client, world.session);
            }
            await sleep(jitter(submitMs));
          }
        })(),
      );

      for (const agent of world.externals)
        loops.push(
          (async () => {
            await sleep(Math.random() * pollMs);
            let nextBeat = Date.now() + jitter(20_000);
            let nextRequest = Date.now() + jitter(requestMs);
            const provider = world.hostedLinks.get(agent.id);
            while (running()) {
              if (Date.now() >= nextBeat) {
                nextBeat = Date.now() + jitter(20_000);
                await heartbeat(ctx.client, agent);
              }
              const polled = await claim(ctx.client, agent);
              if (polled.status === 200 && polled.body.job) {
                counters.claimed++;
                const jobId: string = polled.body.job.id;
                if (claimedIds.has(jobId)) counters.duplicateClaims++;
                claimedIds.add(jobId);
                const result = await submitResult(
                  ctx.client,
                  agent,
                  jobId,
                  polled.body.leaseToken,
                  syntheticOutput(),
                );
                if (result.status === 200) {
                  counters.completed++;
                  acceptQueue.push(jobId);
                }
                const requester = providerOf.get(agent.id);
                if (requester) activePairs.delete(requester);
              }
              if (provider && Date.now() >= nextRequest && !hostedBusy.has(provider.id)) {
                nextRequest = Date.now() + jitter(requestMs);
                hostedBusy.add(provider.id);
                try {
                  await hostedRequest(ctx, agent, provider, counters);
                } finally {
                  hostedBusy.delete(provider.id);
                }
              }
              await sleep(jitter(pollMs));
            }
          })(),
        );
    }
    await Promise.all(loops);
  });

  const summary = recorder.summary();
  const server = await ctx.server.stats(worlds.map((world) => world.operatorId));
  const blobs = Object.values(server.blobs);
  return {
    id: 'S1',
    title: 'Runtime steady state',
    metrics: {
      owners: worlds.length,
      agents: worlds.reduce((sum, world) => sum + world.externals.length + world.hosted.length, 0),
      durationSeconds: summary.elapsedSeconds,
      rps: summary.totals.rps,
      requests: summary.totals.requests,
      errors: summary.totals.errors,
      refused: summary.totals.refused,
      errorRate: summary.totals.requests ? summary.totals.errors / summary.totals.requests : 0,
      ...counters,
      maxOwnerBlobBytes: blobs.length ? Math.max(...blobs) : 0,
    },
    requests: summary,
    server,
  };
}

async function hostedRequest(
  ctx: Context,
  agent: AgentHandle,
  provider: AgentHandle,
  counters: { hostedRequests: number; hostedCompleted: number },
): Promise<void> {
  const created = await runtimeRequest(ctx.client, agent, provider);
  if (created.status !== 201) return;
  counters.hostedRequests++;
  const jobId: string = created.body.job.id;
  for (let attempt = 0; attempt < 4; attempt++) {
    await sleep(500);
    const status = await runtimeRequestStatus(ctx.client, agent, jobId);
    if (status.status !== 200) return;
    if (!['queued', 'running'].includes(status.body.job.status)) {
      if (status.body.job.status === 'completed') counters.hostedCompleted++;
      return;
    }
  }
}
