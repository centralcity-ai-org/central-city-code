import { randomUUID } from 'node:crypto';
import { benchIp, Recorder } from '../client.js';
import { numberOption, withRecorder, type Context, type ScenarioResult } from './ops.js';

const TEMPLATE = 'template:extractor@1.0.0';

/**
 * S4 anonymous creation via POST /api/public/agents: the same number of creates from a single
 * source address, then spread over many addresses (distinct /24s inside 198.18.0.0/15).
 */
export async function runS4(ctx: Context): Promise<ScenarioResult> {
  const count = numberOption(ctx, 's4-creates', 120);
  const concurrency = numberOption(ctx, 's4-concurrency', 8);
  ctx.log(`S4 anonymous creation: ${count} single-source, ${count} spread`);
  await ctx.server.reset();
  const total = new Recorder();
  const phases: Array<Record<string, number | string>> = [];
  await withRecorder(ctx.client, total, async () => {
    // Addresses in 198.19.0.0/16 so S4 never shares a source with owners or runtimes (198.18/16).
    const single = benchIp(65_535 + 1);
    const spread = (index: number) => benchIp(65_535 + 2 + ((index * 257) % 65_000));
    for (const [phase, address] of [
      ['single-source', () => single],
      ['spread', spread],
    ] as const) {
      const recorder = new Recorder(total);
      ctx.client.recorder = recorder;
      let next = 0;
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (next < count) {
            const index = next++;
            await ctx.client.send({
              method: 'POST',
              path: '/api/public/agents',
              route: `POST /api/public/agents (${phase})`,
              body: { template: TEMPLATE, idempotency_key: randomUUID() },
              ip: address(index),
            });
          }
        }),
      );
      recorder.stop();
      const summary = recorder.summary();
      const route = summary.routes[0]!;
      phases.push({
        phase,
        rps: summary.totals.rps,
        p50Ms: route.p50,
        p95Ms: route.p95,
        created: route.statuses['201'] ?? 0,
        refused: route.refused,
        errors: route.errors,
      });
    }
  });
  const summary = total.summary();
  return {
    id: 'S4',
    title: 'Anonymous creation',
    metrics: Object.fromEntries(
      phases.flatMap((phase) => [
        [`${phase.phase}.created`, phase.created],
        [`${phase.phase}.refused`, phase.refused],
        [`${phase.phase}.p95Ms`, phase.p95Ms],
        [`${phase.phase}.rps`, phase.rps],
      ]),
    ),
    requests: summary,
    server: await ctx.server.stats(),
    tables: [
      {
        title: `${count} creates per phase, concurrency ${concurrency}`,
        columns: Object.keys(phases[0] ?? {}),
        rows: phases.map((phase) => Object.values(phase)),
      },
    ],
  };
}
