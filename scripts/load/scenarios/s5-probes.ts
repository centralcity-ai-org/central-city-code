import { randomUUID } from 'node:crypto';
import { benchIp, Recorder } from '../client.js';
import type { OwnerWorld } from '../seed.js';
import {
  claim,
  submitJob,
  submitResult,
  syntheticOutput,
  withRecorder,
  type Context,
  type ScenarioResult,
} from './ops.js';

export interface Probe {
  name: string;
  pass: boolean;
  detail: string;
}

/**
 * S5 correctness probes: signed-request nonce replay, job and anonymous-creation idempotency,
 * result idempotency and stale heartbeat refusal. Runs on a seeded owner before the load.
 */
export async function runS5(
  ctx: Context,
  world: OwnerWorld,
): Promise<ScenarioResult & { probes: Probe[] }> {
  const recorder = new Recorder();
  const probes: Probe[] = [];
  const probe = (name: string, pass: boolean, detail: string) =>
    probes.push({ name, pass, detail });
  await ctx.server.reset();
  ctx.log('S5 correctness probes');
  await withRecorder(ctx.client, recorder, async () => {
    const [requester, provider] = world.pairs[0]!;

    // 1. Nonce replay: identical signed bytes twice → second is refused with 409.
    requester.sequence++;
    const raw = JSON.stringify({ sequence: requester.sequence });
    const headers = {
      ...ctx.client.signed(requester.token!, 'POST', '/api/runtime/heartbeat', raw),
    };
    const first = await ctx.client.send({
      method: 'POST',
      path: '/api/runtime/heartbeat',
      route: 'probe replay (first)',
      raw,
      headers,
      ip: requester.ip,
    });
    const replay = await ctx.client.send({
      method: 'POST',
      path: '/api/runtime/heartbeat',
      route: 'probe replay (second)',
      raw,
      headers,
      ip: requester.ip,
      expect: [409],
    });
    probe(
      'nonce-replay-refused',
      first.status === 200 && replay.status === 409,
      `first ${first.status}, replay ${replay.status}`,
    );

    // 2. Stale heartbeat sequence (fresh nonce, old sequence) → 409.
    const stale = await ctx.client.send({
      method: 'POST',
      path: '/api/runtime/heartbeat',
      route: 'probe stale heartbeat',
      body: { sequence: 0 },
      ip: requester.ip,
      runtimeToken: requester.token!,
      expect: [409],
    });
    probe('stale-heartbeat-refused', stale.status === 409, `status ${stale.status}`);

    // 3. Bad signature → 401.
    const forged = await ctx.client.send({
      method: 'GET',
      path: '/api/runtime/jobs',
      route: 'probe forged signature',
      headers: {
        ...ctx.client.signed(requester.token!, 'GET', '/api/runtime/jobs', ''),
        'X-CC-Signature': '0'.repeat(64),
      },
      ip: requester.ip,
      expect: [401],
    });
    probe('forged-signature-refused', forged.status === 401, `status ${forged.status}`);

    // 4. Job idempotency: same key + input → same id; same key + other input → 409.
    const key = randomUUID();
    const input = `Probe idempotent job ${key}`;
    const a = await submitJob(ctx.client, world.session, requester, provider, input, key);
    const b = await submitJob(ctx.client, world.session, requester, provider, input, key);
    const c = await submitJob(
      ctx.client,
      world.session,
      requester,
      provider,
      `${input} changed`,
      key,
      [409],
    );
    probe(
      'job-idempotency',
      a.status === 201 && b.status === 201 && a.body.job.id === b.body.job.id && c.status === 409,
      `statuses ${a.status}/${b.status}/${c.status}, same id ${a.body?.job?.id === b.body?.job?.id}`,
    );

    // 5. Result idempotency: identical result twice → 200 both; a different result → 409.
    const claimed = await claim(ctx.client, provider);
    if (claimed.body?.job?.id === a.body?.job?.id) {
      const lease: string = claimed.body.leaseToken;
      const r1 = await submitResult(ctx.client, provider, a.body.job.id, lease, syntheticOutput());
      const r2 = await submitResult(ctx.client, provider, a.body.job.id, lease, syntheticOutput());
      const r3 = await submitResult(
        ctx.client,
        provider,
        a.body.job.id,
        lease,
        syntheticOutput(8),
        [409],
      );
      probe(
        'result-idempotency',
        r1.status === 200 && r2.status === 200 && r3.status === 409,
        `statuses ${r1.status}/${r2.status}/${r3.status}`,
      );
    } else
      probe(
        'result-idempotency',
        false,
        `claim returned ${claimed.status} with a different or no job`,
      );

    // 6. Anonymous idempotency: same key twice from one source → same agent.
    const anonKey = randomUUID();
    const ip = benchIp(131_000);
    const body = { template: 'template:extractor@1.0.0', idempotency_key: anonKey };
    const x = await ctx.client.send({
      method: 'POST',
      path: '/api/public/agents',
      route: 'probe anonymous create',
      body,
      ip,
    });
    const y = await ctx.client.send({
      method: 'POST',
      path: '/api/public/agents',
      route: 'probe anonymous create',
      body,
      ip,
    });
    const idOf = (response: { body: any }) =>
      response.body?.agent?.id ?? response.body?.agent?.agent_id;
    probe(
      'anonymous-idempotency',
      x.status < 300 && y.status < 300 && idOf(x) !== undefined && idOf(x) === idOf(y),
      `statuses ${x.status}/${y.status}, same agent ${idOf(x) !== undefined && idOf(x) === idOf(y)}`,
    );
  });
  const summary = recorder.summary();
  return {
    id: 'S5',
    title: 'Correctness probes',
    metrics: {
      passed: probes.filter((p) => p.pass).length,
      failed: probes.filter((p) => !p.pass).length,
    },
    requests: summary,
    server: await ctx.server.stats(),
    probes,
    tables: [
      {
        title: 'Probes',
        columns: ['probe', 'pass', 'detail'],
        rows: probes.map((p) => [p.name, p.pass ? 'PASS' : 'FAIL', p.detail]),
      },
    ],
  };
}
