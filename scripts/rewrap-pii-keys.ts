import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Database } from '../server/database.js';
import { piiKeys } from '../server/google/pii-keys.js';
import { rewrapPiiKeys } from '../server/google/pii.js';

/**
 * Retires CITY_PII_KEK_PREVIOUS (docs/GOOGLE_SIGNIN.md "Date of birth"). Re-wraps every stored
 * date of birth's data key under the current CITY_PII_KEK; the ciphertext is unchanged. Prints
 * counts only, never ids, dates, keys or database errors.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… CITY_PII_KEK=<new> CITY_PII_KEK_PREVIOUS=<old> \
 *     node --import tsx scripts/rewrap-pii-keys.ts            # dry run: {"pending":N,...}
 *   … scripts/rewrap-pii-keys.ts --confirm                    # re-wrap
 *
 * Idempotent: run --confirm until the dry run reports "pending":0, then remove
 * CITY_PII_KEK_PREVIOUS and deploy. "unknownRoot" rows were wrapped under a key the server no
 * longer has: those owners enter their date of birth again.
 */
async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--confirm' && arg !== '--dry-run');
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error('Usage: rewrap-pii-keys.ts [--dry-run (default) | --confirm]');
    process.exit(1);
  }
  const hosted = process.env.CITY_HOSTED === '1';
  const keyring = piiKeys(process.env, { hosted: true });
  if (!keyring.available) {
    console.error(`PII key unavailable (reason=${keyring.reason}); nothing was changed.`);
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Pick<Database, 'query' | 'transaction'> & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  if (hosted) db = (await openPostgres(loadHostedConfig().databaseUrl)) as unknown as typeof db;
  else {
    const lock = await acquireDataLock(resolve(process.env.CITY_DATA_DIR ?? '.local/data'));
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as typeof db;
    release = () => lock.release();
  }
  try {
    console.log(
      JSON.stringify(await rewrapPiiKeys(db, keyring, { confirm: argv.includes('--confirm') })),
    );
  } catch {
    console.error('PII key re-wrap failed; rows already re-wrapped stay valid. Re-run it.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
