import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { isDay } from '../../shared/count-log/index.js';
import { LEAVES_PAGE_MAX, type CountLog } from './service.js';
import { FEED_LIMITS } from './pending.js';

/*
 * Public, cacheable routes of the verifiable agent count, the owner-only proof route and the
 * daily cron endpoint (spec §3 and §7). Public responses carry only hashes, counts and days: no
 * agent ids, owner ids, names or salts.
 */
const SHORT = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';

const leavesQuery = z
  .object({
    from: z.coerce.number().int().min(0).default(0),
    to: z.coerce.number().int().min(1).optional(),
  })
  .strict();
// Only an optional day: other query strings would each be a separate edge-cache entry. The verify page adds ?after=<checkpoint day> to skip a stale cached list.
const checkpointsQuery = z
  .object({ after: z.string().refine(isDay, 'Use YYYY-MM-DD.').optional() })
  .strict();
const feedQuery = z
  .object({
    before: z
      .string()
      .regex(/^\d{1,18}$/)
      .optional(),
    limit: z.coerce.number().int().min(1).max(FEED_LIMITS.max).optional(),
  })
  .strict();
/** The live head of the pending feed: about 2 s at the edge. */
const LIVE = 'public, max-age=2, s-maxage=2, stale-while-revalidate=5';
/** A feed page whose entries are all removed never changes again. */
const FINAL = 'public, max-age=86400, s-maxage=86400';
/** Seconds until the next daily checkpoint (00:10 UTC), when a confirmed entry may change. */
function untilCheckpoint(now: number): number {
  const next = new Date(now);
  next.setUTCHours(0, 10, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return Math.max(2, Math.floor((next.getTime() - now) / 1000));
}
const dateParams = z.object({ date: z.string().refine(isDay, 'Use YYYY-MM-DD.') }).strict();
const agentParams = z.object({ id: z.string().uuid() }).strict();
/** Per signed-in owner. */
export const OWNER_PROOF_RATE = { max: 10, windowMs: 60_000 } as const;

function bearerMatches(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerCountLogRoutes(
  app: FastifyInstance,
  d: {
    log: CountLog;
    owner: (request: FastifyRequest) => Promise<Operator>;
    /** Vercel Cron's bearer secret (CRON_SECRET); without it the cron route answers 404. */
    cronSecret?: string;
    /** The shared rate limiter; the owner proof route allows OWNER_PROOF_RATE per owner. */
    limit?: (key: string, max: number, windowMs: number) => Promise<void>;
  },
): void {
  app.get('/api/public/count-log/checkpoints', async (request, reply) => {
    checkpointsQuery.parse(request.query);
    return reply.header('Cache-Control', SHORT).send({ checkpoints: await d.log.checkpoints() });
  });
  // Live log Phase 2: new agents' fingerprints as they are created (pending), confirmed by the
  // next checkpoint. Hashes, days and minutes only.
  app.get('/api/public/count-log/feed', async (request, reply) => {
    const query = feedQuery.parse(request.query);
    const feed = await d.log.feed(query);
    const age = untilCheckpoint(Date.now());
    const cache =
      query.before === undefined || feed.stability === 'live'
        ? LIVE
        : feed.stability === 'final'
          ? FINAL
          : `public, max-age=${age}, s-maxage=${age}`;
    const { stability: _stability, ...body } = feed;
    return reply.header('Cache-Control', cache).send(body);
  });
  app.get('/api/public/count-log/checkpoints/:date', async (request, reply) => {
    const { date } = dateParams.parse(request.params);
    const checkpoint = await d.log.checkpointOn(date);
    if (!checkpoint)
      return reply.code(404).send({ error: 'No checkpoint for that day.', code: 'not_found' });
    return reply.header('Cache-Control', IMMUTABLE).send({ checkpoint });
  });
  app.get('/api/public/count-log/leaves', async (request, reply) => {
    const { from, to } = leavesQuery.parse(request.query);
    const page = await d.log.leaves(from, to ?? from + LEAVES_PAGE_MAX);
    const end = from + page.leaves.length;
    // A full page wholly under a checkpoint never changes; the last partial page can grow.
    const settled = page.leaves.length === LEAVES_PAGE_MAX || (to !== undefined && end >= to);
    return reply
      .header('Cache-Control', settled ? IMMUTABLE : SHORT)
      .send({ from, tree_size: page.tree_size, leaves: page.leaves });
  });
  app.get('/api/public/count-log/withdrawn', async (_request, reply) =>
    reply.header('Cache-Control', SHORT).send({ withdrawn: await d.log.withdrawn() }),
  );
  // The owner's own agents, id and name only, for "Check my agent" on /downtown/verify. Unlike
  // /api/snapshot it reads nothing else and advances no work.
  app.get('/api/count-log/my-agents', async (request, reply) => {
    const operator = await d.owner(request);
    return reply
      .header('Cache-Control', 'private, no-store')
      .send({ agents: await d.log.ownerAgents(operator.id) });
  });
  // The owner's own proof: console session only; "not yours" and "does not exist" look the same.
  app.get('/api/agents/:id/count-proof', async (request, reply) => {
    const operator = await d.owner(request);
    const { id } = agentParams.parse(request.params);
    // Under the degraded 'ip' prefix (classified in server/rate-limit.ts), keyed per owner: the
    // key never collides with the global ip:<address> buckets.
    await d.limit?.(
      `ip:count-proof:${operator.id}`,
      OWNER_PROOF_RATE.max,
      OWNER_PROOF_RATE.windowMs,
    );
    const result = await d.log.ownerProof(operator.id, id);
    if (!result) return reply.code(404).send({ error: 'Agent not found.', code: 'not_found' });
    return reply.header('Cache-Control', 'private, no-store').send(result);
  });
  // Vercel Cron (GET with Authorization: Bearer CRON_SECRET), once a day at 00:10 UTC.
  app.get('/api/cron/count-checkpoint', async (request, reply) => {
    if (!bearerMatches(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const { checkpoint, created } = await d.log.checkpoint();
    return reply.send({
      date: checkpoint.date,
      tree_size: checkpoint.tree_size,
      withdrawn: checkpoint.withdrawn,
      hash: checkpoint.hash,
      created,
    });
  });
}
