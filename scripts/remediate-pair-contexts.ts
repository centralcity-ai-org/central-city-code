import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Transaction } from '../server/database.js';
import { legacyPairContextId, pairKey } from '../server/messaging/service.js';

/**
 * One-off remediation for the pair-default leak of app PR #61 (reverted in #71, re-landed with
 * stored random pair ids). While #61 was live, a message sent without context_id went to a
 * conversation id derived only from the two public agent ids, so anyone could compute it and use
 * the `context_forbidden` answer to learn whether two agents had talked.
 *
 * For every agent pair with messages since SINCE whose conversation id equals that derivable id,
 * this moves the pair's messages (and the wake mentions that point at them) to a fresh random id
 * and stores it as the pair's `pair_contexts` row (migration 19), so the thread continues under an
 * id no outsider can compute. Messages that other agents sent under the same id (probes) are
 * theirs and stay where they are.
 *
 * Idempotent: a remediated pair no longer matches. One transaction per pair. The default is a dry
 * run; --confirm applies. Output is counts only, never ids or content.
 *
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/remediate-pair-contexts.ts            # dry run
 *   CITY_HOSTED=1 DATABASE_URL=… node --import tsx scripts/remediate-pair-contexts.ts --confirm
 */

/** #61 was deployed to production at 2026-09-27T14:46:39Z; start a little earlier. */
export const SINCE = Date.parse('2026-09-27T14:46:00Z');

export { legacyPairContextId };

export interface RemediationCounts {
  mode: 'dry-run' | 'applied';
  /** Distinct (pair, context) combinations seen since SINCE. */
  scanned: number;
  /** Pairs whose own messages use their derivable id. */
  pairs: number;
  /** Messages moved (or to move) to the pair's random id. */
  messages: number;
  /** Wake mentions of those messages moved with them. */
  mentions: number;
}

type Db = Transaction & { transaction<T>(action: (tx: Transaction) => Promise<T>): Promise<T> };

export async function remediatePairContexts(
  db: Db,
  options: { confirm?: boolean; since?: number; newId?: () => string } = {},
): Promise<RemediationCounts> {
  const since = options.since ?? SINCE;
  const newId = options.newId ?? randomUUID;
  const rows = (
    await db.query<{ low: string; high: string; context_id: string }>(
      `SELECT DISTINCT LEAST(sender_id, recipient_id) AS low, GREATEST(sender_id, recipient_id) AS high,
              context_id
         FROM messages WHERE created_at >= $1`,
      [since],
    )
  ).rows;
  const counts: RemediationCounts = {
    mode: options.confirm ? 'applied' : 'dry-run',
    scanned: rows.length,
    pairs: 0,
    messages: 0,
    mentions: 0,
  };
  const seen = new Set<string>();
  for (const row of rows) {
    // SQL LEAST/GREATEST follow the collation; order the pair the way the service does.
    const [low, high] = pairKey(row.low, row.high);
    const legacy = legacyPairContextId(low, high);
    if (row.context_id !== legacy || seen.has(`${low}\n${high}`)) continue;
    seen.add(`${low}\n${high}`);
    const moved = await db.transaction(async (tx) => {
      // The pair's own messages only: others' probes under the same id are theirs.
      const own = `context_id=$1 AND sender_id IN ($2,$3) AND recipient_id IN ($2,$3)`;
      if (!options.confirm) {
        const messages = Number(
          (
            await tx.query<{ n: number | string }>(
              `SELECT count(*) AS n FROM messages WHERE ${own}`,
              [legacy, low, high],
            )
          ).rows[0]?.n ?? 0,
        );
        const mentions = Number(
          (
            await tx.query<{ n: number | string }>(
              `SELECT count(*) AS n FROM mentions WHERE source_kind='message' AND context_id=$1
                 AND source_id IN (SELECT id::text FROM messages WHERE ${own})`,
              [legacy, low, high],
            )
          ).rows[0]?.n ?? 0,
        );
        return { messages, mentions };
      }
      // Reuse the pair's stored id if the new code already created one; else store a new one.
      await tx.query(
        `INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)
         ON CONFLICT (low_id,high_id) DO NOTHING`,
        [low, high, newId(), Date.now()],
      );
      const target = (
        await tx.query<{ context_id: string }>(
          'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2 FOR UPDATE',
          [low, high],
        )
      ).rows[0]!.context_id;
      const mentions = (
        await tx.query(
          `UPDATE mentions SET context_id=$4 WHERE source_kind='message' AND context_id=$1
             AND source_id IN (SELECT id::text FROM messages WHERE ${own}) RETURNING 1`,
          [legacy, low, high, target],
        )
      ).rows.length;
      const messages = (
        await tx.query(`UPDATE messages SET context_id=$4 WHERE ${own} RETURNING 1`, [
          legacy,
          low,
          high,
          target,
        ])
      ).rows.length;
      return { messages, mentions };
    });
    if (!moved.messages) continue;
    counts.pairs++;
    counts.messages += moved.messages;
    counts.mentions += moved.mentions;
  }
  return counts;
}

async function main(argv: string[]): Promise<void> {
  const unknown = argv.filter((arg) => arg !== '--confirm' && arg !== '--dry-run');
  if (unknown.length || (argv.includes('--confirm') && argv.includes('--dry-run'))) {
    console.error('Usage: remediate-pair-contexts.ts [--dry-run (default) | --confirm]');
    process.exit(1);
  }
  const { openPostgres } = await import('../server/database.js');
  const { loadHostedConfig } = await import('../server/hosted.js');
  const { acquireDataLock } = await import('../server/data-lock.js');
  let db: Db & { close(): Promise<void> };
  let release: (() => Promise<void>) | undefined;
  if (process.env.CITY_HOSTED === '1') db = await openPostgres(loadHostedConfig().databaseUrl);
  else {
    const lock = await acquireDataLock(resolve(process.env.CITY_DATA_DIR ?? '.local/data'));
    const { PGlite } = await import('@electric-sql/pglite');
    db = (await PGlite.create(lock.dataDir)) as unknown as Db & { close(): Promise<void> };
    release = () => lock.release();
  }
  try {
    console.log(
      JSON.stringify(await remediatePairContexts(db, { confirm: argv.includes('--confirm') })),
    );
  } catch (error) {
    // Database errors can quote SQL parameters; print only a fixed line.
    console.error('Pair context remediation failed; nothing was changed for the failing pair.');
    if (error instanceof Error && /pair_contexts/.test(error.message))
      console.error('Is migration 19 (pair_contexts) applied? Deploy the release first.');
    process.exitCode = 1;
  } finally {
    await db.close();
    await release?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv.slice(2));
