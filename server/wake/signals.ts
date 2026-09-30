import type { Database, Transaction } from '../database.js';

/**
 * After-commit wake signals. Code running inside a transaction records what changed
 * (`emit`); the signals are delivered only after that transaction commits, so an in-process
 * waiter never re-reads before the data is visible, and a rolled-back write wakes nobody.
 * Transactions of a database wrapped with `withWakeSignals` carry their signal list; other
 * transactions fall back to a short delayed broadcast (the batched cursor poll is the backstop).
 */
export type WakeSignal =
  { kind: 'inbox' | 'room' | 'mention'; id: string; seq: number } | { kind: 'outbox' };

const pending = new WeakMap<object, WakeSignal[]>();
const listeners = new Set<(signals: WakeSignal[]) => void>();

export function emit(tx: Transaction, ...signals: WakeSignal[]): void {
  const list = pending.get(tx);
  if (list) {
    list.push(...signals);
    return;
  }
  const timer = setTimeout(() => {
    for (const listener of listeners) listener(signals);
  }, 50);
  timer.unref?.();
}

/** Receives signals of unwrapped transactions (every instance in this process). */
export function onUnwrappedSignals(listener: (signals: WakeSignal[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** A database whose transactions deliver their wake signals to `onCommit` after COMMIT. */
export function withWakeSignals(db: Database, onCommit: (signals: WakeSignal[]) => void): Database {
  return {
    query: (sql, params) => db.query(sql, params),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
    async transaction(action) {
      const signals: WakeSignal[] = [];
      const result = await db.transaction(async (tx) => {
        const wrapped: Transaction = {
          query: (sql, params) => tx.query(sql, params),
          exec: (sql) => tx.exec(sql),
        };
        pending.set(wrapped, signals);
        return action(wrapped);
      });
      if (signals.length) onCommit(signals);
      return result;
    },
  };
}
