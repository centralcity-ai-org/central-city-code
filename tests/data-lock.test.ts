import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireDataLock,
  directPath,
  isTrustedSystemLink,
  walkDirectPath,
} from '../server/data-lock.js';
import { backupDatabase } from '../server/recovery.js';

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

async function scratch(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'city-data-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('an OS temp path resolves to one canonical data path', async (t) => {
  const name = `city-data-lock-${randomUUID()}`;
  const input = join(tmpdir(), name);
  const canonical = join(await realpath(tmpdir()), name);
  t.after(() => rm(canonical, { recursive: true, force: true }));
  assert.equal(await directPath(input), canonical);
  const lock = await acquireDataLock(input);
  try {
    assert.equal(lock.dataDir, canonical);
    assert.ok(await stat(`${canonical}.central-city.lock`));
  } finally {
    await lock.release();
  }
  await assert.rejects(stat(`${canonical}.central-city.lock`), { code: 'ENOENT' });
});

test(
  'macOS /tmp and /private/tmp spellings share one lock',
  { skip: process.platform !== 'darwin' && 'macOS system links only' },
  async (t) => {
    const id = `city-data-lock-${randomUUID()}`;
    t.after(() => rm(join('/private/tmp', id), { recursive: true, force: true }));
    const results = await Promise.allSettled([
      acquireDataLock(join('/tmp', id, 'd')),
      acquireDataLock(join('/private/tmp', id, 'd')),
    ]);
    const acquired = results.filter((result) => result.status === 'fulfilled');
    const refused = results.filter((result) => result.status === 'rejected');
    assert.equal(acquired.length, 1);
    assert.equal(refused.length, 1);
    assert.match(String(refused[0].reason), /locked/);
    assert.equal(acquired[0].value.dataDir, join('/private/tmp', id, 'd'));
    await acquired[0].value.release();
  },
);

test('a user-created parent link is still rejected', async (t) => {
  const root = await scratch(t);
  const real = join(root, 'real');
  // A world-writable parent keeps the link untrusted even when tests run as root.
  const writable = join(root, 'writable');
  const alias = join(writable, 'alias');
  await mkdir(real);
  await mkdir(writable);
  await chmod(writable, 0o777);
  await symlink(real, alias, linkType);
  await assert.rejects(directPath(join(alias, 'data')), /aliases|links/);
  await assert.rejects(acquireDataLock(join(alias, 'data')), /aliases|links/);
  await assert.rejects(stat(join(real, 'data.central-city.lock')), { code: 'ENOENT' });
});

test('a link at the data directory is rejected', async (t) => {
  const root = await scratch(t);
  const real = join(root, 'real');
  const alias = join(root, 'data');
  await mkdir(real);
  await symlink(real, alias, linkType);
  await assert.rejects(directPath(alias), /aliases|links/);
  await assert.rejects(acquireDataLock(alias), /aliases|links/);
  await assert.rejects(stat(`${alias}.central-city.lock`), { code: 'ENOENT' });
});

test('a link inside a data directory blocks backup before any write', async (t) => {
  const root = await scratch(t);
  const data = join(root, 'data');
  const outside = join(root, 'outside');
  const backup = join(root, 'backup.json');
  await mkdir(data);
  await mkdir(outside);
  await writeFile(join(data, 'PG_VERSION'), '17\n');
  await symlink(outside, join(data, 'escape'), linkType);
  await assert.rejects(backupDatabase(data, backup), /aliases|links/);
  await assert.rejects(stat(backup), { code: 'ENOENT' });
  await assert.rejects(stat(`${await realpath(data)}.central-city.lock`), { code: 'ENOENT' });
});

test('only root-owned links under a non-writable root-owned parent are trusted', () => {
  const dir = (uid: number, mode: number) => ({ uid, mode, isDirectory: () => true });
  const rootLink = { uid: 0 };
  assert.equal(isTrustedSystemLink(rootLink, dir(0, 0o40755), 'darwin'), true);
  assert.equal(isTrustedSystemLink(rootLink, dir(0, 0o40775), 'darwin'), false);
  assert.equal(isTrustedSystemLink(rootLink, dir(0, 0o41777), 'darwin'), false);
  assert.equal(isTrustedSystemLink(rootLink, dir(501, 0o40755), 'darwin'), false);
  assert.equal(isTrustedSystemLink({ uid: 501 }, dir(0, 0o40755), 'darwin'), false);
  assert.equal(
    isTrustedSystemLink(rootLink, { uid: 0, mode: 0o100644, isDirectory: () => false }, 'linux'),
    false,
  );
  assert.equal(isTrustedSystemLink(rootLink, dir(0, 0o40755), 'win32'), false);
});

// In-memory filesystem: lstat/readlink never resolve links, so any path the walk touches
// through an unfollowed link is missing. Entries default to root-owned directories, mode 0755.
type FakeEntry = { uid?: number; mode?: number; link?: string; real?: string };
const posixOnly = { skip: process.platform === 'win32' && 'POSIX link resolution only' };
const system: Record<string, FakeEntry> = {
  '/': {},
  '/private': {},
  '/private/var': {},
  '/private/tmp': { mode: 0o1777 },
  '/var': { link: 'private/var' },
  '/tmp': { link: 'private/tmp' },
  '/Users': {},
  '/Users/bob': { uid: 501 },
};

function fakeFs(extra: Record<string, FakeEntry>) {
  const tree = { ...system, ...extra };
  const find = (path: string) => {
    const entry = tree[path];
    if (!entry) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    return entry;
  };
  const followed: string[] = [];
  return {
    followed,
    async lstat(path: string) {
      const entry = find(path);
      return {
        uid: entry.uid ?? 0,
        mode: entry.mode ?? 0o755,
        nlink: 1,
        isDirectory: () => entry.link === undefined,
        isFile: () => false,
        isSymbolicLink: () => entry.link !== undefined,
      };
    },
    async readlink(path: string) {
      followed.push(path);
      const { link } = find(path);
      if (link === undefined) throw Object.assign(new Error(`EINVAL: ${path}`), { code: 'EINVAL' });
      return link;
    },
    async realpath(path: string) {
      return find(path).real ?? path;
    },
  };
}

test('fake fs: an OS-owned link resolves and its target is still checked', posixOnly, async () => {
  const fs = fakeFs({
    '/private/var/app': { uid: 501 },
    '/private/var/App': { uid: 501, real: '/private/var/app' },
  });
  assert.equal(await walkDirectPath('/var/app/data', fs), '/private/var/app/data');
  assert.equal(await walkDirectPath('/tmp/x/d', fs), '/private/tmp/x/d');
  await assert.rejects(walkDirectPath('/var/App/data', fs), /aliases/);
});

test('fake fs: absolute and relative link targets both resolve', posixOnly, async () => {
  const fs = fakeFs({ '/abs': { link: '/private/var' }, '/private/var/up': { link: '../tmp' } });
  assert.equal(await walkDirectPath('/abs/data', fs), '/private/var/data');
  assert.equal(await walkDirectPath('/var/up/data', fs), '/private/tmp/data');
  assert.deepEqual(fs.followed, ['/abs', '/var', '/private/var/up']);
});

test('fake fs: a user-controlled link inside a trusted target is rejected', posixOnly, async () => {
  const fs = fakeFs({
    '/data': { link: '/Users/bob/x' },
    '/Users/bob/x': { uid: 501, link: '/Users/bob/real' },
    '/Users/bob/real': { uid: 501 },
    '/owned': { link: '/Users/bob/root-link' },
    '/Users/bob/root-link': { link: '/private/var' },
  });
  await assert.rejects(walkDirectPath('/data/db', fs), /aliases/);
  await assert.rejects(walkDirectPath('/owned/db', fs), /aliases/);
  assert.deepEqual(fs.followed, ['/data', '/owned']);
});

test('fake fs: a link under a group- or world-writable parent is rejected', posixOnly, async () => {
  const fs = fakeFs({
    '/shared': { mode: 0o775 },
    '/opt': { link: '/shared/opt' },
    '/shared/opt': { link: '/private/var' },
    '/private/tmp/l': { link: '/private/var' },
  });
  await assert.rejects(walkDirectPath('/opt/data', fs), /aliases/);
  await assert.rejects(walkDirectPath('/tmp/l/data', fs), /aliases/);
  assert.deepEqual(fs.followed, ['/opt', '/tmp']);
});

test('fake fs: a root-owned link cycle stops at the hop limit', posixOnly, async () => {
  const fs = fakeFs({ '/loop-a': { link: '/loop-b' }, '/loop-b': { link: 'loop-a' } });
  await assert.rejects(walkDirectPath('/loop-a/data', fs), /aliases/);
  assert.equal(fs.followed.length, 40);
});

test('fake fs: a trusted link is never followed as the data path', posixOnly, async () => {
  const fs = fakeFs({ '/private/var/db': { link: '/private/tmp' } });
  await assert.rejects(walkDirectPath('/var', fs), /aliases/);
  await assert.rejects(walkDirectPath('/var/db', fs), /aliases/);
  assert.deepEqual(fs.followed, ['/var']);
});
