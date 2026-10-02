import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { CRON_DRAIN_BUDGET_MS, type Wake } from './service.js';

/**
 * The scheduled wake outbox drain (vercel.json "crons", every minute).
 *
 * On serverless nothing runs between requests: the after-commit drain (waitUntil) delivers new
 * wake-ups at once, but a retry after a backoff, a room or provider rate limit, a lease left by an
 * instance that stopped, or the rest of a long queue waits for the next drain. Without this route
 * that next drain only comes from unrelated traffic, and a mention can expire unanswered.
 *
 * Vercel Cron calls GET with `Authorization: Bearer <CRON_SECRET>`. Fail closed: without a
 * configured secret (16+ characters) or with any other header the route answers 404, exactly like
 * an unknown path. The response carries counts only.
 */
export const WAKE_DRAIN_PATH = '/api/cron/wake-drain';

export function cronAuthorized(header: string | undefined, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith('Bearer ')) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Lapsed room-task claims cleared per sweep batch, and batches per scheduled run. */
export const TASK_LAPSE_BATCH = 100;
export const TASK_LAPSE_MAX_BATCHES = 20;

/**
 * Clears room-task claims past expiry plus grace in bounded batches (docs/ROOM_TASKS.md). Reads
 * lapse a claim lazily, but a room nobody reads would keep a lapsed claim "claimed" forever; this
 * runs on the same schedule as the wake drain, inside the same deadline. The sweep statement is
 * conditional, so running it twice (or concurrently on two instances) is harmless. Any error is
 * contained: the wake drain's result never depends on it.
 */
export async function sweepTaskLapses(
  sweep: (limit: number) => Promise<{ lapsed: unknown[] }>,
  deadline: number,
  now: () => number = Date.now,
): Promise<{ lapsed: number; error: boolean }> {
  let lapsed = 0;
  try {
    for (let batch = 0; batch < TASK_LAPSE_MAX_BATCHES && now() < deadline; batch++) {
      const cleared = (await sweep(TASK_LAPSE_BATCH)).lapsed.length;
      lapsed += cleared;
      if (cleared < TASK_LAPSE_BATCH) break;
    }
    return { lapsed, error: false };
  } catch {
    return { lapsed, error: true };
  }
}

export function registerWakeCron(
  app: FastifyInstance,
  d: {
    wake: Pick<Wake, 'drainNow'>;
    cronSecret: string | undefined;
    /** The room-task lapse sweep (server/rooms/tasks-service.ts `sweepLapsedTasks`). */
    sweepTasks?: (limit: number) => Promise<{ lapsed: unknown[] }>;
    /**
     * Elric's drain (server/elric/service.ts), when Elric is on: deferred invocations (a cold
     * model endpoint, or a run that ran out of time) are retried here every minute. It runs side
     * by side with the wake drain under the same deadline and caps itself at its own run budget.
     */
    drainElric?: (budgetMs: number) => Promise<number>;
    /** The run's budget (defaults to the wake drain's). */
    budgetMs?: number;
    now?: () => number;
    /** Operational log line sink (defaults to console.warn). */
    log?: (line: string) => void;
  },
): void {
  app.get(WAKE_DRAIN_PATH, async (request, reply) => {
    if (!cronAuthorized(request.headers.authorization, d.cronSecret))
      return reply.code(404).send({ error: 'Not found.' });
    const now = d.now ?? Date.now;
    const budget = d.budgetMs ?? CRON_DRAIN_BUDGET_MS;
    // All run side by side under one deadline; neither the sweep nor Elric throws into the drain.
    const [handled, tasks, elric] = await Promise.all([
      d.wake.drainNow(budget),
      d.sweepTasks ? sweepTaskLapses(d.sweepTasks, now() + budget, now) : Promise.resolve(null),
      d.drainElric
        ? d.drainElric(budget).then(
            (count) => ({ handled: count, error: false }),
            () => ({ handled: 0, error: true }),
          )
        : Promise.resolve(null),
    ]);
    if (elric && (elric.handled || elric.error))
      (d.log ?? console.warn)(`elric.cron_drain handled=${elric.handled} error=${elric.error}`);
    // The response shape stays the drain's counts; the sweep's result goes to the log line.
    if (tasks && (tasks.lapsed || tasks.error))
      (d.log ?? console.warn)(`room_tasks.lapse_sweep lapsed=${tasks.lapsed} error=${tasks.error}`);
    return reply.header('Cache-Control', 'no-store').send(handled);
  });
}
