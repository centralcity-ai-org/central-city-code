/**
 * Load-test server child. Runs today's application in hosted mode against an in-process PGlite
 * database wrapped by the instrument, on 127.0.0.1 with an ephemeral port. Never reads
 * DATABASE_URL or any hosted environment: the parent strips them and this file sets its own.
 */
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../../server/app.js';
import type { HostedConfig } from '../../server/hosted.js';
import type { CityLimits } from '../../server/limits.js';
import type { RateLimiter } from '../../server/rate-limit.js';
import { Instrument } from './instrument.js';
import { round } from './histogram.js';
import { LOAD_ORIGIN } from './client.js';

/** Generous caps for the `--limits=off` profile (capacity checks still run, far from binding). */
export const UNBOUNDED_LIMITS: Partial<CityLimits> = {
  operators: 100_000,
  agentsPerWorkspace: 1_000,
  connectionsPerWorkspace: 5_000,
  jobsPerWorkspace: 100_000,
  activeJobsPerWorkspace: 10_000,
  activeJobsPerAgent: 1_000,
  replayNoncesPerAgent: 100_000,
  unclaimedAgentsPerSource: 100_000,
  unclaimedAgentsPerSite: 100_000,
  unclaimedAgentsPerNetwork: 100_000,
  unclaimedAgentsPerRegion: 100_000,
  unclaimedCreatesPerSourcePerHour: 100_000,
  unclaimedCreatesPerSitePerHour: 100_000,
  unclaimedCreatesPerNetworkPerHour: 100_000,
  unclaimedCreatesPerRegionPerHour: 100_000,
};

const allowAll: RateLimiter = {
  hit: async () => ({ allowed: true, retryAfterMs: 0 }),
  count: async () => 0,
};

async function main(): Promise<void> {
  const limits = process.argv.includes('--limits=on') ? 'on' : 'off';
  // Synthetic, per-process, never printed or persisted.
  process.env.CITY_RATE_LIMIT_KEY = randomBytes(48).toString('base64url');
  const hosted: HostedConfig = {
    databaseUrl: 'postgresql://pglite.invalid/load',
    publicOrigin: LOAD_ORIGIN,
    allowedOrigins: [LOAD_ORIGIN],
    trustProxy: true,
  };
  const instrument = new Instrument();
  const database = instrument.wrap(await PGlite.create('memory://'));
  const app = await createApp({
    hosted,
    database,
    trustProxyHops: 1,
    signingKey: null,
    logLine: () => {},
    ...(limits === 'off' ? { rateLimiter: allowAll, limits: UNBOUNDED_LIMITS } : {}),
  });
  const loop = monitorEventLoopDelay({ resolution: 5 });
  loop.enable();
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listening address.');
  const ms = (ns: number) => round(ns / 1e6);
  let cpuStart = process.cpuUsage();
  let wallStart = performance.now();
  process.on('message', (message: { type: string; id?: number; operatorIds?: string[] }) => {
    if (message.type === 'reset') {
      instrument.reset();
      loop.reset();
      cpuStart = process.cpuUsage();
      wallStart = performance.now();
      process.send!({ type: 'reset', id: message.id });
    } else if (message.type === 'stats') {
      const blobs = Object.fromEntries(
        (message.operatorIds ?? [])
          .filter((id) => instrument.blobByOperator.has(id))
          .map((id) => [id, instrument.blobByOperator.get(id)!]),
      );
      process.send!({
        type: 'stats',
        id: message.id,
        db: instrument.stats(),
        blobs,
        eventLoopDelayMs: {
          p50: ms(loop.percentile(50)),
          p95: ms(loop.percentile(95)),
          p99: ms(loop.percentile(99)),
          max: ms(loop.max),
          mean: ms(loop.mean),
        },
        cpuPercent: (() => {
          const used = process.cpuUsage(cpuStart);
          return round(
            ((used.user + used.system) / 1000 / (performance.now() - wallStart)) * 100,
            1,
          );
        })(),
        memory: { rssMb: round(process.memoryUsage().rss / 2 ** 20, 1) },
      });
    } else if (message.type === 'stop') {
      void app.close().finally(() => process.exit(0));
    }
  });
  process.on('disconnect', () => void app.close().finally(() => process.exit(0)));
  process.send!({ type: 'ready', port: address.port, limits });
}

if (process.send) {
  main().catch((error: unknown) => {
    process.send!({
      type: 'error',
      message: error instanceof Error ? error.message : 'Server start failed.',
    });
    process.exit(1);
  });
}
