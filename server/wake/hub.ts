import type { Database } from '../database.js';

/**
 * Per-instance wake hub. Long-polls and streams
 * wait here WITHOUT holding a database connection:
 *
 * - same instance: after-commit signals (server/wake/signals.ts) resolve waiters at once;
 * - any instance: while anyone waits, ONE batched cursor query per `pollMs` (default 500 ms)
 *   covers every watched inbox, room and mention cursor. Each poll is a single `db.query`, which
 *   borrows a pool client for that statement only and returns it.
 *
 * So N waiters cost one short query per interval and zero held pool clients.
 */
export type WakeKind = 'inbox' | 'room' | 'mention';
export interface WakeKey {
  kind: WakeKind;
  id: string;
  /** Wake when the cursor (latest seq) is greater than this. */
  after: number;
}
interface Waiter {
  keys: WakeKey[];
  resolve(changed: boolean): void;
}

const keyOf = (kind: WakeKind, id: string) => `${kind}:${id}`;

export class WakeHub {
  private waiters = new Set<Waiter>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private closed = false;
  /** Number of batched cursor queries run (for tests and metrics). */
  polls = 0;

  constructor(
    private db: Pick<Database, 'query'>,
    private pollMs = 500,
    private onTick?: () => void,
  ) {}

  get waiting(): number {
    return this.waiters.size;
  }

  /** Resolves true when any key's cursor passes `after`, false on timeout or abort. */
  wait(keys: WakeKey[], timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || !keys.length || timeoutMs <= 0 || signal?.aborted)
      return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        keys,
        resolve: (changed) => {
          if (!this.waiters.delete(waiter)) return;
          clearTimeout(timeout);
          signal?.removeEventListener('abort', abort);
          if (!this.waiters.size) this.stop();
          resolve(changed);
        },
      };
      const abort = () => waiter.resolve(false);
      timeout = setTimeout(() => waiter.resolve(false), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });
      this.waiters.add(waiter);
      this.schedule();
    });
  }

  /** An after-commit signal from this instance: the cursor of (kind, id) reached `seq`. */
  notify(kind: WakeKind, id: string, seq: number): void {
    for (const waiter of [...this.waiters])
      if (waiter.keys.some((key) => key.kind === kind && key.id === id && seq > key.after))
        waiter.resolve(true);
  }

  close(): void {
    this.closed = true;
    for (const waiter of [...this.waiters]) waiter.resolve(false);
    this.stop();
  }

  private stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(): void {
    if (this.timer || this.polling || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.poll();
    }, this.pollMs);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    if (!this.waiters.size || this.closed) return;
    this.polling = true;
    try {
      const ids: Record<WakeKind, Set<string>> = {
        inbox: new Set(),
        room: new Set(),
        mention: new Set(),
      };
      for (const waiter of this.waiters) for (const key of waiter.keys) ids[key.kind].add(key.id);
      const rows = (
        await this.db.query<{ k: WakeKind; id: string; v: number | string }>(
          `SELECT 'inbox' AS k, agent_id AS id, next_seq-1 AS v FROM inbox_cursors WHERE agent_id = ANY($1::text[])
           UNION ALL SELECT 'room' AS k, id, next_seq-1 AS v FROM rooms WHERE id = ANY($2::text[])
           UNION ALL SELECT 'mention' AS k, agent_id AS id, next_mention_seq-1 AS v FROM wake_cursors WHERE agent_id = ANY($3::text[])`,
          [[...ids.inbox], [...ids.room], [...ids.mention]],
        )
      ).rows;
      this.polls++;
      const latest = new Map(rows.map((row) => [keyOf(row.k, row.id), Number(row.v)]));
      for (const waiter of [...this.waiters])
        if (waiter.keys.some((key) => (latest.get(keyOf(key.kind, key.id)) ?? 0) > key.after))
          waiter.resolve(true);
    } catch {
      // A failed poll is retried on the next interval; waiters still time out on schedule.
    } finally {
      this.polling = false;
    }
    this.onTick?.();
    if (this.waiters.size) this.schedule();
  }
}
