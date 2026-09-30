import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

/** A single local connector owns a sequence file. Persist before sending, never after. */
export class SequenceStore {
  private value = -1;
  private closed = false;
  private constructor(
    private readonly path: string,
    private readonly release: () => Promise<void>,
  ) {}

  static async acquire(file: string): Promise<SequenceStore> {
    const path = resolve(file);
    await mkdir(dirname(path), { recursive: true });
    const lockPath = `${path}.lock`;
    let lock;
    try {
      lock = await open(lockPath, 'wx', 0o600);
    } catch {
      throw new Error(
        'Cannot acquire sequence lock. Stop the other connector; see CONNECTOR.md for crash recovery.',
      );
    }
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const store = new SequenceStore(path, async () => {
      await lock.close();
      await unlink(lockPath);
    });
    try {
      const handle = await open(path, 'r');
      let content: string;
      try {
        if ((await handle.stat()).size > 64) throw new Error('Sequence file is invalid.');
        content = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      const n = Number(content.trim());
      if (!/^\d+$/.test(content.trim()) || !Number.isSafeInteger(n) || n < 0)
        throw new Error('Sequence file is invalid.');
      store.value = n;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        await store.close();
        throw error;
      }
    }
    return store;
  }

  async next(): Promise<number> {
    if (this.closed) throw new Error('Sequence store is closed.');
    const next = this.value + 1;
    if (!Number.isSafeInteger(next)) throw new Error('Sequence exhausted; rotate credentials.');
    const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(String(next));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    this.value = next;
    return next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.release();
  }
}
