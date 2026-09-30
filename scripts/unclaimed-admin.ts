import { resolve } from 'node:path';
import type { Database } from '../server/database.js';
import { openPostgres } from '../server/database.js';
import { acquireDataLock } from '../server/data-lock.js';
import { loadHostedConfig } from '../server/hosted.js';
import { listTop, parseAdminArgs, purge, reconcile } from '../server/autonomy/admin.js';
import { reconcileAiWorkspaces } from '../server/workspaces/admin.js';

/**
 * Operator abuse response for unclaimed partitions. Uses the same database configuration as the
 * app: hosted PostgreSQL (CITY_HOSTED=1, DATABASE_URL) or the local PGlite directory
 * (CITY_DATA_DIR, default .local/data, which must not be in use by a running app).
 * `reconcile` recomputes the capacity counters from the partition rows and prints the JSON diff;
 * it writes only with --confirm and is safe while the app serves traffic (hosted). It also
 * reconciles the live AI-owned workspace counters (`ai_workspaces` in the output).
 */
let command: ReturnType<typeof parseAdminArgs>;
try {
  command = parseAdminArgs(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
const secret = process.env.CITY_RATE_LIMIT_KEY ?? '';
if (command.command === 'purge' && 'prefix' in command.target && secret.length < 32) {
  console.error('Purging by address prefix needs the deployment CITY_RATE_LIMIT_KEY.');
  process.exit(1);
}
let db: Database;
let release: (() => Promise<void>) | undefined;
if (process.env.CITY_HOSTED === '1') db = await openPostgres(loadHostedConfig().databaseUrl);
else {
  const lock = await acquireDataLock(resolve(process.env.CITY_DATA_DIR ?? '.local/data'));
  const { PGlite } = await import('@electric-sql/pglite');
  db = await PGlite.create(lock.dataDir);
  release = () => lock.release();
}
try {
  const result =
    command.command === 'list-top'
      ? { command: 'list-top', by: command.by, rows: await listTop(db, command.by, command.limit) }
      : command.command === 'reconcile'
        ? {
            ...(await reconcile(db, { confirm: command.confirm })),
            ai_workspaces: await reconcileAiWorkspaces(db, { confirm: command.confirm }),
          }
        : { command: 'purge', ...(await purge(db, command.target, secret)) };
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unclaimed administration failed.');
  process.exitCode = 1;
} finally {
  await db.close();
  await release?.();
}
