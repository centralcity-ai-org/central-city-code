import { performance } from 'node:perf_hooks';
import type { Database, Transaction } from '../../server/database.js';
import { round, Samples, type LatencySummary } from './histogram.js';

const LOCK_SQL = /FROM workspaces WHERE operator_id=\$1 FOR UPDATE/;
const BLOB_SQL = /^UPDATE workspaces SET data=\$2::jsonb WHERE operator_id=\$1/;

interface ShapeStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface InstrumentStats {
  transactions: number;
  workspaceLockTransactions: number;
  /** Time from db.transaction() until the callback starts (connection / PGlite mutex wait). */
  transactionWaitMs: LatencySummary;
  /** Callback start until COMMIT resolved, all transactions. */
  transactionHoldMs: LatencySummary;
  /** Duration of the `workspaces … FOR UPDATE` statement (row-lock acquire). */
  lockAcquireMs: LatencySummary;
  /** Row lock acquired until COMMIT resolved: how long one owner's workspace is serialized. */
  lockHoldMs: LatencySummary;
  /** Bytes of the workspace JSON written per UPDATE. */
  blobBytes: LatencySummary;
  blobWrites: number;
  /** Largest current workspace blob observed per operator id (bytes). */
  largestBlobBytes: number;
  queriesTotal: number;
  queryShapes: Array<{
    sql: string;
    count: number;
    totalMs: number;
    meanMs: number;
    maxMs: number;
  }>;
}

/** Wraps a Database to time transactions, the workspace row lock and blob writes. */
export class Instrument {
  private txWait = new Samples();
  private txHold = new Samples();
  private lockAcquire = new Samples();
  private lockHold = new Samples();
  private blob = new Samples();
  private shapes = new Map<string, ShapeStats>();
  private transactions = 0;
  private lockTransactions = 0;
  private queries = 0;
  readonly blobByOperator = new Map<string, number>();

  reset(): void {
    this.txWait = new Samples();
    this.txHold = new Samples();
    this.lockAcquire = new Samples();
    this.lockHold = new Samples();
    this.blob = new Samples();
    this.shapes.clear();
    this.transactions = 0;
    this.lockTransactions = 0;
    this.queries = 0;
  }

  private shape(sql: string, ms: number): void {
    this.queries++;
    const key = sql.replace(/\s+/g, ' ').trim().slice(0, 140);
    const entry = this.shapes.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    entry.count++;
    entry.totalMs += ms;
    if (ms > entry.maxMs) entry.maxMs = ms;
    this.shapes.set(key, entry);
  }

  wrap(db: Database): Database {
    const timedQuery =
      (
        target: Pick<Transaction, 'query'>,
        onQuery?: (sql: string, params: unknown[] | undefined, start: number, end: number) => void,
      ) =>
      async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        const start = performance.now();
        const result = await target.query<T>(sql, params);
        const end = performance.now();
        this.shape(sql, end - start);
        onQuery?.(sql, params, start, end);
        return result;
      };
    const recordBlob = (sql: string, params: unknown[] | undefined) => {
      if (!BLOB_SQL.test(sql) || !params) return;
      const bytes = Buffer.byteLength(String(params[1] ?? ''));
      this.blob.add(bytes);
      this.blobByOperator.set(String(params[0]), bytes);
    };
    return {
      query: timedQuery(db, (sql, params) => recordBlob(sql, params)),
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      transaction: async <T>(action: (tx: Transaction) => Promise<T>): Promise<T> => {
        const requested = performance.now();
        let started = 0;
        let lockedAt: number | null = null;
        const result = await db.transaction(async (tx) => {
          started = performance.now();
          this.txWait.add(started - requested);
          const wrapped: Transaction = {
            query: timedQuery(tx, (sql, params, start, end) => {
              if (lockedAt === null && LOCK_SQL.test(sql)) {
                lockedAt = end;
                this.lockAcquire.add(end - start);
              }
              recordBlob(sql, params);
            }),
            exec: (sql) => tx.exec(sql),
          };
          return action(wrapped);
        });
        const committed = performance.now();
        this.transactions++;
        this.txHold.add(committed - started);
        if (lockedAt !== null) {
          this.lockTransactions++;
          this.lockHold.add(committed - lockedAt);
        }
        return result;
      },
    };
  }

  stats(): InstrumentStats {
    let largest = 0;
    for (const bytes of this.blobByOperator.values()) largest = Math.max(largest, bytes);
    return {
      transactions: this.transactions,
      workspaceLockTransactions: this.lockTransactions,
      transactionWaitMs: this.txWait.summary(),
      transactionHoldMs: this.txHold.summary(),
      lockAcquireMs: this.lockAcquire.summary(),
      lockHoldMs: this.lockHold.summary(),
      blobBytes: this.blob.summary(),
      blobWrites: this.blob.count,
      largestBlobBytes: largest,
      queriesTotal: this.queries,
      queryShapes: [...this.shapes.entries()]
        .map(([sql, entry]) => ({
          sql,
          count: entry.count,
          totalMs: round(entry.totalMs),
          meanMs: round(entry.totalMs / entry.count, 3),
          maxMs: round(entry.maxMs),
        }))
        .sort((a, b) => b.totalMs - a.totalMs)
        .slice(0, 25),
    };
  }
}
