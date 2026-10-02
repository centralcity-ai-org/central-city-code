import type { FastifyInstance } from 'fastify';
import { cronAuthorized } from '../wake/cron.js';
import type { ElricModelWiring, ElricTierNumber } from './endpoints.js';

/**
 * Elric model health (docs/ELRIC_MODEL.md): an internal probe of each configured self-hosted
 * endpoint (GET /v1/models: no tokens, no prompt). Not a public endpoint: the route answers only
 * a Vercel-Cron-style `Authorization: Bearer <CRON_SECRET>`, else 404 like an unknown path. Its
 * answer carries states and timings only, never a URL, model output or provider text. A probe of
 * a sleeping endpoint also starts waking it, so a scheduled probe keeps the first invocation of
 * the day from waiting.
 */
export const ELRIC_HEALTH_PATH = '/api/cron/elric-health';

export type ElricTierHealth =
  | { state: 'unconfigured' }
  | { state: 'ready' | 'waking' | 'down'; latency_ms: number; code?: string };

export async function probeElricModels(
  models: ElricModelWiring | null,
  clock: () => number = Date.now,
): Promise<Record<ElricTierNumber, ElricTierHealth>> {
  const one = async (tier: ElricTierNumber): Promise<ElricTierHealth> => {
    const adapter = models?.adapters[tier];
    if (!adapter) return { state: 'unconfigured' };
    const started = clock();
    const result = await adapter.probe();
    return {
      state: result.state,
      latency_ms: Math.max(0, clock() - started),
      ...(result.code ? { code: result.code } : {}),
    };
  };
  const [t1, t2] = await Promise.all([one(1), one(2)]);
  return { 1: t1, 2: t2 };
}

export function registerElricHealth(
  app: FastifyInstance,
  d: {
    models: ElricModelWiring | null;
    cronSecret: string | undefined;
    clock?: () => number;
    log?: (line: string) => void;
  },
): void {
  app.get(ELRIC_HEALTH_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const tiers = await probeElricModels(d.models, d.clock);
    // One operational line per probe: states only.
    (d.log ?? console.warn)(
      JSON.stringify({
        event: 'elric.model_health',
        t1: tiers[1].state,
        t2: tiers[2].state,
      }),
    );
    return reply.header('Cache-Control', 'no-store').send({ tiers });
  });
}
