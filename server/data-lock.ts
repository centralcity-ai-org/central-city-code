import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, mkdir, open, readFile, readlink, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';

export const INCOMPLETE_RECOVERY = '.central-city-recovery-incomplete';
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

const ALIAS_ERROR = 'Symbolic links, junctions and filesystem aliases are not supported.';

/**
 * An intermediate link is trusted only when the OS owns it: root owns the link and its
 * parent directory, and nobody else can write that parent (e.g. macOS /var and /tmp).
 */
export function isTrustedSystemLink(
  link: Pick<Stats, 'uid'>,
  parent: Pick<Stats, 'uid' | 'mode' | 'isDirectory'>,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform !== 'win32' &&
    link.uid === 0 &&
    parent.isDirectory() &&
    parent.uid === 0 &&
    (parent.mode & 0o022) === 0
  );
}

type DirectPathFs = {
  lstat(
    path: string,
  ): Promise<Pick<Stats, 'uid' | 'mode' | 'nlink' | 'isDirectory' | 'isFile' | 'isSymbolicLink'>>;
  readlink(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
};

/** Bound on followed links (Linux SYMLOOP_MAX), so a root-owned link cycle cannot loop forever. */
const MAX_LINK_HOPS = 40;

/**
 * Local cooperative protection, not a defense against hostile filesystem writers.
 * Returns the canonical path: OS-owned ancestor links are resolved; any other link fails.
 */
export function directPath(input: string): Promise<string> {
  return walkDirectPath(input, { lstat, readlink, realpath });
}

/** @internal The walk behind directPath with an injectable filesystem; exported for tests. */
export async function walkDirectPath(input: string, fs: DirectPathFs): Promise<string> {
  if (!input || input.includes('\0') || /^[\\/]{2}/.test(input))
    throw new Error('Use a direct local filesystem path.');
  const parts = input.replaceAll('\\', '/').split('/');
  if (
    parts.some(
      (part, index) =>
        part === '..' ||
        /[. ]$/.test(part) ||
        (part.includes(':') && !(index === 0 && /^[a-z]:$/i.test(part))) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new Error('Path aliases and reserved path components are not supported.');
  const target = resolve(input);
  let current = parse(target).root;
  let segments = target.slice(current.length).split(sep).filter(Boolean);
  let hops = 0;
  let index = 0;
  while (index < segments.length) {
    const next = resolve(current, segments[index]);
    let entry;
    try {
      entry = await fs.lstat(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
    if (entry.isSymbolicLink()) {
      // Follow only an OS-owned link above the data path, never the data path itself. Splice
      // its target in and re-walk from the root so every target component meets these rules.
      hops += 1;
      if (
        hops > MAX_LINK_HOPS ||
        index === segments.length - 1 ||
        !isTrustedSystemLink(entry, await fs.lstat(current))
      )
        throw new Error(ALIAS_ERROR);
      const spliced = resolve(current, await fs.readlink(next), ...segments.slice(index + 1));
      current = parse(spliced).root;
      segments = spliced.slice(current.length).split(sep).filter(Boolean);
      index = 0;
      continue;
    }
    let real;
    try {
      real = await fs.realpath(next);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      break;
    }
    if (!samePath(real, next)) throw new Error(ALIAS_ERROR);
    if (entry.isFile() && entry.nlink !== 1)
      throw new Error('Hard-linked files are not supported.');
    current = next;
    index += 1;
  }
  const canonical = resolve(current, ...segments.slice(index));
  if (!isAbsolute(target) || target === parse(target).root || canonical === parse(canonical).root)
    throw new Error('A filesystem root is not a data path.');
  return canonical;
}

export async function acquireDataLock(input: string): Promise<{
  dataDir: string;
  release(): Promise<void>;
}> {
  const dataDir = await directPath(input);
  await mkdir(dirname(dataDir), { recursive: true, mode: 0o700 });
  await directPath(dataDir);
  try {
    await lstat(resolve(dataDir, INCOMPLETE_RECOVERY));
    throw new Error('Incomplete recovery directory. Inspect it and restore to a new directory.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const lockPath = `${dataDir}.central-city.lock`;
  const token = randomUUID();
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error('Data directory is locked. Stop its owner; never remove a live lock.');
    throw error;
  }
  try {
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() }),
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
  let released = false;
  return {
    dataDir,
    async release() {
      if (released) return;
      await directPath(lockPath);
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: string };
      if (record.token !== token) throw new Error('Lock ownership changed; refusing to remove it.');
      await unlink(lockPath);
      released = true;
    },
  };
}
