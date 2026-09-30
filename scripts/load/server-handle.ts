import type { ServerHandle, ServerStats } from './scenarios/ops.js';

/** The subset of ChildProcess the handle uses (injectable for tests). */
export interface ChildLike {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly connected: boolean;
  send(message: unknown): boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'message', listener: (message: any) => void): unknown;
  on(event: 'exit', listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'disconnect', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface HandleOptions {
  /** Bound on every IPC call (reset/stats) and on startup. */
  callTimeoutMs?: number;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

/**
 * Wraps the server child. Exit, disconnect and error handlers stay attached for the child's whole
 * life: once the child is gone every pending and future call rejects immediately, and each call
 * rejects on its own after `callTimeoutMs`, so a dead server fails the run fast.
 */
export async function connectServer(
  child: ChildLike,
  options: HandleOptions = {},
): Promise<ServerHandle> {
  const callTimeoutMs = options.callTimeoutMs ?? 30_000;
  const pending = new Map<number, { resolve(message: any): void; reject(error: Error): void }>();
  let sequence = 0;
  let dead: Error | null = null;
  let exited = child.exitCode !== null || child.signalCode !== null;
  const exitWaiters: Array<() => void> = [];
  let ready: { resolve(port: number): void; reject(error: Error): void } | null = null;

  const die = (error: Error) => {
    dead ??= error;
    ready?.reject(dead);
    ready = null;
    for (const call of pending.values()) call.reject(dead);
    pending.clear();
  };
  child.on('message', (message: any) => {
    if (message?.type === 'ready') ready?.resolve(message.port);
    else if (message?.type === 'error')
      die(new Error(`Server child failed: ${String(message.message)}`));
    else if (typeof message?.id === 'number') pending.get(message.id)?.resolve(message);
  });
  child.on('exit', (code, signal) => {
    exited = true;
    die(new Error(`Server child exited (code ${code}, signal ${signal}).`));
    for (const waiter of exitWaiters.splice(0)) waiter();
  });
  child.on('disconnect', () => die(new Error('Server child disconnected.')));
  child.on('error', (error) => die(new Error(`Server child error: ${error.message}`)));
  if (exited) die(new Error('Server child exited before it was ready.'));

  const port = await new Promise<number>((resolve, reject) => {
    if (dead) return reject(dead);
    const timer = setTimeout(
      () => die(new Error('Server child did not become ready in time.')),
      options.readyTimeoutMs ?? 60_000,
    );
    ready = {
      resolve: (value) => {
        clearTimeout(timer);
        ready = null;
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
  });

  const call = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      if (dead) return reject(dead);
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Server child did not answer "${type}" within ${callTimeoutMs} ms.`));
      }, callTimeoutMs);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        child.send({ type, id, ...extra });
      } catch (error) {
        pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
        pending.delete(id);
      }
    });

  return {
    port,
    reset: async () => void (await call('reset')),
    stats: async (operatorIds?: string[]) => {
      const { db, blobs, eventLoopDelayMs, cpuPercent, memory } = await call('stats', {
        operatorIds,
      });
      return { db, blobs, eventLoopDelayMs, cpuPercent, memory } as ServerStats;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        if (exited) return resolve();
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, options.stopTimeoutMs ?? 10_000);
        exitWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        try {
          if (child.connected) child.send({ type: 'stop' });
          else child.kill('SIGTERM');
        } catch {
          child.kill('SIGKILL');
        }
      }),
  };
}
