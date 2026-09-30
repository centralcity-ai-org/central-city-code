import { Recorder } from '../client.js';
import {
  connect,
  createAgent,
  heartbeat,
  ownerName,
  registerOwner,
  type AgentHandle,
} from '../seed.js';
import { round } from '../histogram.js';
import {
  jobCycle,
  keepAlive,
  numberOption,
  withRecorder,
  type Context,
  type ScenarioResult,
} from './ops.js';

/**
 * S2 hot-owner concurrency sweep. One owner per level with N concurrent connector pairs, each
 * running full job cycles (submit → claim → result → accept) against the same workspace row.
 * Every step serializes on that owner's `workspaces … FOR UPDATE` lock.
 */
export async function runS2(ctx: Context): Promise<ScenarioResult> {
  const levels = (ctx.options['s2-levels'] ?? '1,2,4,8,16,32').split(',').map(Number);
  const levelMs = numberOption(ctx, 's2-seconds', 6) * 1000;
  const total = new Recorder();
  const seenClaims = new Set<string>();
  const duplicates = { claims: 0 };
  const rows: Array<Array<string | number>> = [];
  const perLevel: Array<Record<string, number>> = [];
  let lastStats: ScenarioResult['server'] | undefined;
  ctx.log(`S2 hot owner sweep: levels ${levels.join(',')} × ${levelMs / 1000}s`);
  for (const level of levels) {
    const owner = await registerOwner(
      ctx.client,
      ownerName(ctx.runId, level, 'hot'),
      ctx.ips.take(),
    );
    const pairs: Array<[AgentHandle, AgentHandle]> = [];
    for (let index = 0; index < level; index++) {
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
        'extract',
        ctx.ips.take(),
      );
      await connect(ctx.client, owner.session, from, to);
      await heartbeat(ctx.client, from);
      await heartbeat(ctx.client, to);
      pairs.push([from, to]);
    }
    await ctx.server.reset();
    const recorder = new Recorder(total);
    const deadline = Date.now() + levelMs;
    let cycles = 0;
    let partial = 0;
    await withRecorder(ctx.client, recorder, async () => {
      const done = () => Date.now() >= deadline;
      const pump = keepAlive(ctx.client, pairs.flat(), done);
      await Promise.all(
        pairs.map(async ([from, to]) => {
          while (!done()) {
            const steps = await jobCycle(
              ctx.client,
              owner.session,
              from,
              to,
              0,
              seenClaims,
              duplicates,
            );
            if (steps === 4) cycles++;
            else {
              // A refused or failed step: back off briefly instead of hammering the limiter.
              partial++;
              await new Promise((resolve) => setTimeout(resolve, 250));
            }
          }
        }),
      );
      await pump;
    });
    const summary = recorder.summary();
    const stats = await ctx.server.stats([owner.operatorId]);
    lastStats = stats;
    const mutate = summary.routes.filter((route) => route.route !== 'POST /api/runtime/heartbeat');
    const p95 = Math.max(0, ...mutate.map((route) => route.p95));
    const entry = {
      level,
      cyclesPerSecond: round(cycles / summary.elapsedSeconds),
      rps: summary.totals.rps,
      worstRouteP95Ms: p95,
      lockHoldP95Ms: stats.db.lockHoldMs.p95,
      txWaitP95Ms: stats.db.transactionWaitMs.p95,
      eventLoopP99Ms: stats.eventLoopDelayMs.p99,
      blobBytes: stats.blobs[owner.operatorId] ?? 0,
      errors: summary.totals.errors,
      refused: summary.totals.refused,
      incompleteCycles: partial,
    };
    perLevel.push(entry);
    rows.push(Object.values(entry));
    ctx.log(
      `  level ${level}: ${entry.cyclesPerSecond} cycles/s, worst p95 ${p95} ms, refused ${entry.refused}, errors ${entry.errors}`,
    );
  }
  total.stop();
  const best = perLevel.reduce(
    (a, b) => (b.cyclesPerSecond > a.cyclesPerSecond ? b : a),
    perLevel[0]!,
  );
  // Aggregate request stats come from the per-level recorders; latencies above are per level.
  const summary = total.summary();
  return {
    id: 'S2',
    title: 'Hot owner concurrency sweep',
    metrics: {
      levels,
      secondsPerLevel: levelMs / 1000,
      peakCyclesPerSecond: best.cyclesPerSecond,
      peakAtConcurrency: best.level,
      errors: perLevel.reduce((sum, entry) => sum + entry.errors, 0),
      refused: perLevel.reduce((sum, entry) => sum + entry.refused, 0),
      duplicateClaims: duplicates.claims,
    },
    requests: summary,
    server: lastStats!,
    tables: [
      {
        title: 'Concurrency sweep (one owner, N connector pairs, full job cycles)',
        columns: Object.keys(perLevel[0] ?? {}),
        rows,
      },
    ],
    notes: [
      'The route table aggregates all levels (setup excluded); the sweep table shows each level.',
      'Server stats shown are for the last (highest) level only.',
    ],
  };
}
