import { OwnerSession, Recorder } from '../client.js';
import {
  connect,
  createAgent,
  heartbeat,
  ownerName,
  registerOwner,
  type AgentHandle,
} from '../seed.js';
import { round, Samples } from '../histogram.js';
import {
  jobCycle,
  keepAlive,
  numberOption,
  snapshot,
  withRecorder,
  type Context,
  type ScenarioResult,
} from './ops.js';

/**
 * S3 blob growth. One owner accumulates completed jobs (each with a padded result) and events
 * in its single JSONB workspace row; mutation latency is reported against blob size.
 */
export async function runS3(ctx: Context): Promise<ScenarioResult> {
  const jobs = numberOption(ctx, 's3-jobs', 420);
  const pad = numberOption(ctx, 's3-output-bytes', 2048);
  const bucket = numberOption(ctx, 's3-bucket', 60);
  const concurrency = numberOption(ctx, 's3-concurrency', 4);
  // Work is spread over many pairs and owner addresses so the per-agent runtime and per-address
  // request limits (limits=on) do not mask the blob-size effect this scenario measures.
  const pairCount = Math.max(concurrency, numberOption(ctx, 's3-pairs', 16));
  ctx.log(`S3 blob growth: ${jobs} jobs with ${pad}-byte results`);
  const owner = await registerOwner(ctx.client, ownerName(ctx.runId, 1, 'blob'), ctx.ips.take());
  const sessions = Array.from({ length: concurrency }, () => {
    const session = new OwnerSession(owner.session.name, ctx.ips.take());
    session.cookie = owner.session.cookie;
    return session;
  });
  const pairs: Array<[AgentHandle, AgentHandle]> = [];
  for (let index = 0; index < pairCount; index++) {
    const from = await createAgent(
      ctx.client,
      owner.session,
      `R${index}`,
      'external',
      'research',
      ctx.ips.take(),
    );
    const to = await createAgent(
      ctx.client,
      owner.session,
      `P${index}`,
      'external',
      'verify',
      ctx.ips.take(),
    );
    await connect(ctx.client, owner.session, from, to);
    await heartbeat(ctx.client, from);
    await heartbeat(ctx.client, to);
    pairs.push([from, to]);
  }
  await ctx.server.reset();
  const recorder = new Recorder();
  const rows: Array<Array<string | number>> = [];
  const curve: Array<Record<string, number>> = [];
  let completed = 0;
  let started = 0;
  let incomplete = 0;
  const seenClaims = new Set<string>();
  const duplicates = { claims: 0 };
  await withRecorder(ctx.client, recorder, async () => {
    let finished = false;
    const pump = keepAlive(ctx.client, pairs.flat(), () => finished);
    try {
      for (let from = 0; from < jobs; from += bucket) {
        const completedBefore = completed;
        const window = new Recorder(recorder);
        ctx.client.recorder = window;
        const target = Math.min(jobs, from + bucket);
        await Promise.all(
          sessions.map(async (session, worker) => {
            // Worker w owns pairs w, w+concurrency, … so no pair is ever used concurrently.
            let turn = 0;
            while (started < target) {
              started++;
              const mine = pairs.filter((_, index) => index % concurrency === worker);
              const [requester, provider] = mine[turn++ % mine.length]!;
              const steps = await jobCycle(
                ctx.client,
                session,
                requester,
                provider,
                pad,
                seenClaims,
                duplicates,
              );
              if (steps === 4) completed++;
              else incomplete++;
            }
          }),
        );
        const snap = await snapshot(ctx.client, owner.session);
        window.stop();
        const stats = await ctx.server.stats([owner.operatorId]);
        const merged = new Samples();
        const summary = window.summary();
        for (const route of summary.routes)
          if (route.route !== 'POST /api/runtime/heartbeat' && route.route !== 'GET /api/snapshot')
            merged.add(route.p95);
        const entry = {
          jobsDone: completed,
          blobKiB: round((stats.blobs[owner.operatorId] ?? 0) / 1024, 1),
          cyclesPerSecond: round((completed - completedBefore) / summary.elapsedSeconds),
          worstMutationP95Ms: round(merged.max()),
          submitP95Ms: summary.routes.find((r) => r.route === 'POST /api/jobs')?.p95 ?? 0,
          acceptP95Ms:
            summary.routes.find((r) => r.route === 'POST /api/jobs/:id/accept')?.p95 ?? 0,
          snapshotMs: round(snap.ms),
          errors: summary.totals.errors,
          refused: summary.totals.refused,
        };
        curve.push(entry);
        rows.push(Object.values(entry));
        ctx.client.recorder = recorder;
      }
    } finally {
      finished = true;
      await pump;
    }
  });
  const summary = recorder.summary();
  const server = await ctx.server.stats([owner.operatorId]);
  const first = curve[0];
  const last = curve[curve.length - 1];
  return {
    id: 'S3',
    title: 'Workspace blob growth',
    metrics: {
      jobs,
      completed,
      incomplete,
      duplicateClaims: duplicates.claims,
      outputPadBytes: pad,
      finalBlobKiB: last?.blobKiB ?? 0,
      firstBucketWorstP95Ms: first?.worstMutationP95Ms ?? 0,
      lastBucketWorstP95Ms: last?.worstMutationP95Ms ?? 0,
      errors: summary.totals.errors,
      refused: summary.totals.refused,
    },
    requests: summary,
    server,
    tables: [
      {
        title: `p95 vs blob size (buckets of ${bucket} job cycles, concurrency ${concurrency}, ${pairCount} pairs)`,
        columns: Object.keys(curve[0] ?? {}),
        rows,
      },
    ],
    notes: [
      'Owner requests rotate over one address per worker and cycles rotate over many agent pairs so rate limits do not bind; see S2 for the single-address behavior.',
      'jobsPerWorkspace (default 1000) and events (last 1000) bound the blob with limits on; with limits off only events are bounded.',
    ],
  };
}
