import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubError,
  READ_PERMISSIONS,
  appJwt,
  assertOwnRef,
  createGitHubApp,
  fetchTransport,
  parseAppKey,
} from '../server/rooms/repos/github.js';
import {
  loadRoomReposConfig,
  parseInstallationOwners,
  roomReposEnabled,
} from '../server/rooms/repos/config.js';
import { commitSha, fakeGitHub, generateAppKey, type FakeRepo } from './fake-github.js';

/**
 * GitHub App client for room repos: App JWT, per-operation repo-scoped
 * installation tokens, the cc/ ref guard, error mapping and configuration parsing. Fake GitHub
 * only; the key pair is generated per run.
 */
const APP_ID = '424242';
const key = generateAppKey();
const head = commitSha('main-1');
const sandbox: FakeRepo = {
  id: 9001,
  owner: 'example-org',
  name: 'sandbox',
  installation: 77,
  private: true,
  default_branch: 'main',
  branches: { main: head },
  commits: { [head]: { 'README.md': '# Sandbox\n', 'src/app.ts': 'export const x = 1;\n' } },
};
const other: FakeRepo = { ...sandbox, id: 9002, name: 'other' };

test('the App JWT is RS256, signed by the App key, issued by the App id, at most 10 minutes', () => {
  const now = Date.UTC(2026, 8, 29, 12);
  const jwt = appJwt(APP_ID, parseAppKey(key.pem), now);
  const [header, payload] = jwt
    .split('.')
    .slice(0, 2)
    .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString()));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(payload.iss, APP_ID);
  assert.equal(payload.iat, now / 1000 - 60);
  assert.ok(payload.exp - payload.iat <= 600);
  assert.ok(payload.exp > now / 1000);
});

test('a malformed key fails with a message that contains no key material', () => {
  const broken = key.pem.slice(0, 200);
  assert.throws(
    () => parseAppKey(broken),
    (error: Error) =>
      !error.message.includes(broken.slice(40, 80)) &&
      /not a valid RSA private key/.test(error.message),
  );
  // Escaped newlines, as some env editors store them, are accepted.
  assert.ok(parseAppKey(key.pem.replace(/\n/g, '\\n')));
});

test('installation tokens are minted per operation, for one repository, with exactly the asked permissions', async () => {
  const gh = fakeGitHub({ appId: APP_ID, publicKey: key.publicKey, repos: [sandbox, other] });
  const app = createGitHubApp({ appId: APP_ID, privateKey: key.pem }, gh.transport);
  assert.deepEqual(await app.installationFor('example-org/sandbox'), {
    id: 77,
    account_login: 'example-org',
  });
  const one = await app.session(77, { name: 'sandbox' }, 'example-org/sandbox', READ_PERMISSIONS);
  const two = await app.session(77, { name: 'sandbox' }, 'example-org/sandbox', READ_PERMISSIONS);
  assert.equal(gh.tokens.length, 2, 'one token per session, none reused');
  for (const token of gh.tokens) {
    assert.deepEqual(token.repositories, ['sandbox']);
    assert.deepEqual(token.permissions, { contents: 'read', metadata: 'read' });
  }
  assert.equal((await one.repo()).full_name, 'example-org/sandbox');
  assert.equal((await two.commit('main')).sha, head);
  // A token for sandbox cannot read the other repository.
  const wrong = await app.session(77, { name: 'sandbox' }, 'example-org/other', READ_PERMISSIONS);
  await assert.rejects(wrong.repo(), (error: GitHubError) => error.code === 'not_found');
  // The token never appears outside the Authorization header.
  for (const request of gh.requests) {
    assert.ok(!request.path.includes('test-installation-token'));
    assert.ok(!(request.body ?? '').includes('test-installation-token'));
  }
});

test('the ref guard allows refs/heads/cc/<slug>/p<n>-r<rev> only, before any request', async () => {
  for (const ok of ['refs/heads/cc/team-room/p1-r1', 'refs/heads/cc/a/p12-r3'])
    assert.doesNotThrow(() => assertOwnRef(ok), ok);
  for (const bad of [
    'refs/heads/main',
    'refs/heads/cc/../main',
    'refs/heads/cc/room/p1-r1/extra',
    'refs/tags/cc/room/p1-r1',
    'refs/heads/cc/Room/p1-r1',
    'refs/heads/cc/room/p0-r1',
    'refs/heads/cc//p1-r1',
    'heads/cc/room/p1-r1',
  ])
    assert.throws(() => assertOwnRef(bad), /outside refs\/heads\/cc/, bad);
  const gh = fakeGitHub({ appId: APP_ID, publicKey: key.publicKey, repos: [sandbox] });
  const app = createGitHubApp({ appId: APP_ID, privateKey: key.pem }, gh.transport);
  const session = await app.session(77, { id: 9001 }, 'example-org/sandbox', { contents: 'write' });
  const before = gh.requests.length;
  await assert.rejects(session.createOwnRef('refs/heads/main', head), /outside refs\/heads\/cc/);
  assert.equal(gh.requests.length, before, 'a refused ref makes no request');
  await session.createOwnRef('refs/heads/cc/room/p1-r1', head);
  assert.equal(gh.requests.at(-1)!.path, '/repos/example-org/sandbox/git/refs');
});

test('GitHub failures map to stable codes; network errors are unavailable', async () => {
  const gh = fakeGitHub({ appId: APP_ID, publicKey: key.publicKey, repos: [sandbox] });
  const app = createGitHubApp({ appId: APP_ID, privateKey: key.pem }, gh.transport);
  await assert.rejects(
    app.installationFor('example-org/missing'),
    (e: GitHubError) => e.code === 'not_found',
  );
  await assert.rejects(app.installationFor('../etc'), (e: GitHubError) => e.code === 'not_found');
  gh.failWith = 0;
  await assert.rejects(
    app.installationFor('example-org/sandbox'),
    (e: GitHubError) => e.code === 'unavailable',
  );
  gh.failWith = 429;
  await assert.rejects(
    app.installationFor('example-org/sandbox'),
    (e: GitHubError) => e.code === 'rate_limited',
  );
  gh.failWith = 500;
  await assert.rejects(app.installationFor('example-org/sandbox'), (e: GitHubError) => {
    assert.ok(!e.message.includes('failure'), 'no GitHub body in the message');
    return e.code === 'unavailable';
  });
});

test('configuration: the flag, the App id and key, and the installation allowlist', () => {
  assert.equal(roomReposEnabled({}), false);
  assert.equal(roomReposEnabled({ CITY_ROOM_REPOS: 'true' }), false);
  assert.equal(roomReposEnabled({ CITY_ROOM_REPOS: '1' }), true);
  assert.equal(loadRoomReposConfig({}), null);
  assert.equal(loadRoomReposConfig({ CITY_GITHUB_APP_ID: APP_ID }), null);
  const config = loadRoomReposConfig({
    CITY_GITHUB_APP_ID: APP_ID,
    CITY_GITHUB_APP_PRIVATE_KEY: key.pem,
    CITY_GITHUB_INSTALLATION_OWNERS: ' 77:owner-a , 78:owner_b',
  })!;
  assert.deepEqual(
    [...config.installationOwners],
    [
      [77, 'owner-a'],
      [78, 'owner_b'],
    ],
  );
  assert.throws(() =>
    loadRoomReposConfig({ CITY_GITHUB_APP_ID: 'x', CITY_GITHUB_APP_PRIVATE_KEY: key.pem }),
  );
  assert.throws(() => parseInstallationOwners('77'));
  assert.throws(() => parseInstallationOwners('77:a,77:b'));
  assert.throws(() => parseInstallationOwners('77:a b'));
  assert.equal(parseInstallationOwners(undefined).size, 0);
});

test('the production transport stops reading at 8 MB even without content-length', async (t) => {
  const real = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  let pulled = 0;
  globalThis.fetch = (async () => {
    const chunk = new Uint8Array(1024 * 1024).fill(0x61);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
  const res = await fetchTransport({ method: 'GET', path: '/x', headers: {} });
  assert.equal(res.status, 413);
  assert.equal(res.body, '');
  assert.ok(pulled <= 10, `stopped early (${pulled} chunks)`);
});
