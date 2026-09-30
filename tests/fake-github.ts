import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  verify,
  type KeyObject,
} from 'node:crypto';
import type {
  GitHubRequest,
  GitHubResponse,
  GitHubTransport,
} from '../server/rooms/repos/github.js';

/**
 * An in-memory fake of the GitHub REST API surface the room repo tools use.
 * No network. The App key pair is generated per test run, so no key material is committed.
 * Every request is recorded; App JWTs are verified against the generated public key, and
 * installation tokens are bound to the repositories and permissions they were minted for.
 * All ids, names and contents are synthetic.
 */
export interface FakeRepo {
  id: number;
  owner: string;
  name: string;
  installation: number;
  private: boolean;
  default_branch: string;
  /** ref (branch) → commit sha */
  branches: Record<string, string>;
  /** commit sha → { path → file content } */
  commits: Record<string, Record<string, string | Buffer>>;
  /** Paths that are symlinks, per commit. */
  symlinks?: Record<string, string[]>;
  /** Paths that are executable (mode 100755) at every commit. */
  executables?: string[];
}

export interface FakePull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  title: string;
  body: string;
  base: string;
  head: { ref: string; sha: string };
}
/** What the fake records for writes (Git Data API and pulls), per repository id. */
export interface FakeWrites {
  blobs: Map<string, string>;
  trees: Map<
    string,
    { base_tree: string; tree: { path: string; mode: string; sha: string | null }[] }
  >;
  commits: Map<string, { message: string; tree: string; parents: string[] }>;
  refs: Map<string, string>;
  pulls: FakePull[];
}

const sha40 = (seed: string) => createHash('sha1').update(seed).digest('hex');

export function generateAppKey(): { pem: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKey: createPublicKey(publicKey.export({ type: 'spki', format: 'pem' })),
  };
}

export interface FakeGitHub {
  transport: GitHubTransport;
  requests: GitHubRequest[];
  tokens: {
    token: string;
    installation: number;
    repositories: string[];
    /** Set when the token was requested by repository id. */
    repository_ids?: number[];
    permissions: unknown;
  }[];
  repos: FakeRepo[];
  /** Make every call fail with this status (0 = network error). */
  failWith: number | null;
  blobSha(repo: FakeRepo, commit: string, file: string): string;
  writes: FakeWrites;
  /** Check runs and commit statuses GitHub reports per commit sha. */
  checks: Record<string, Record<string, unknown>[]>;
  statuses: Record<string, Record<string, unknown>[]>;
}

export function fakeGitHub(options: {
  appId: string;
  publicKey: KeyObject;
  repos: FakeRepo[];
}): FakeGitHub {
  const requests: GitHubRequest[] = [];
  const tokens: FakeGitHub['tokens'] = [];
  let tokenCounter = 0;
  const blobs = new Map<string, Buffer>();
  // Content-addressed like git: an unchanged file has the same blob sha at every commit.
  const blobSha = (repo: FakeRepo, commit: string, file: string) => {
    const content = repo.commits[commit]?.[file];
    const sha = sha40(
      `blob:${content === undefined ? `missing:${file}` : Buffer.from(content).toString('base64')}`,
    );
    if (content !== undefined) blobs.set(sha, Buffer.from(content));
    return sha;
  };
  const treeSha = (commit: string) => sha40(`tree:${commit}`);
  const dirSha = (commit: string, dir: string) =>
    dir ? sha40(`dir:${commit}:${dir}`) : treeSha(commit);
  const writes: FakeWrites = {
    blobs: new Map(),
    trees: new Map(),
    commits: new Map(),
    refs: new Map(),
    pulls: [],
  };
  let objectCounter = 0;
  const newSha = (kind: string) => sha40(`${kind}:${++objectCounter}`);
  const json = (status: number, value: unknown): GitHubResponse => ({
    status,
    body: JSON.stringify(value),
  });
  const notFound = () => json(404, { message: 'Not Found' });

  function verifyJwt(authorization: string | undefined): boolean {
    const match = /^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(authorization ?? '');
    if (!match) return false;
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(`${match[1]}.${match[2]}`),
      options.publicKey,
      Buffer.from(match[3]!, 'base64url'),
    );
    const payload = JSON.parse(Buffer.from(match[2]!, 'base64url').toString());
    return ok && payload.iss === options.appId && payload.exp - payload.iat <= 600;
  }
  function tokenFor(authorization: string | undefined, repo: FakeRepo) {
    const token = /^token (.+)$/.exec(authorization ?? '')?.[1];
    const found = tokens.find((item) => item.token === token);
    return found &&
      found.installation === repo.installation &&
      found.repositories.includes(repo.name)
      ? found
      : undefined;
  }
  function resolve(repo: FakeRepo, ref: string): string | undefined {
    if (repo.branches[ref]) return repo.branches[ref];
    const full = Object.keys(repo.commits).find(
      (sha) => sha === ref || (ref.length >= 7 && sha.startsWith(ref)),
    );
    return full;
  }
  function listDir(repo: FakeRepo, commit: string, dir: string) {
    const files = Object.keys(repo.commits[commit] ?? {});
    const prefix = dir ? `${dir}/` : '';
    const seen = new Map<string, Record<string, unknown>>();
    for (const file of files) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const [head, ...tail] = rest.split('/');
      const path = `${prefix}${head}`;
      if (seen.has(path)) continue;
      const symlink = repo.symlinks?.[commit]?.includes(path);
      seen.set(
        path,
        tail.length
          ? { path, name: head, type: 'dir', sha: dirSha(commit, path), size: 0 }
          : {
              path,
              name: head,
              type: symlink ? 'symlink' : 'file',
              sha: blobSha(repo, commit, path),
              size: Buffer.byteLength(repo.commits[commit]![path]!),
            },
      );
    }
    return [...seen.values()];
  }

  const fake: FakeGitHub = {
    requests,
    tokens,
    repos: options.repos,
    failWith: null,
    blobSha,
    writes,
    checks: {},
    statuses: {},
    transport: async (request) => {
      requests.push(request);
      if (fake.failWith === 0) throw new Error('network down');
      if (fake.failWith !== null) return json(fake.failWith, { message: 'failure' });
      const url = new URL(`https://api.github.test${request.path}`);
      const parts = url.pathname.split('/').slice(1).map(decodeURIComponent);
      // App endpoints (JWT).
      if (parts[0] === 'app' && parts[1] === 'installations' && parts[3] === 'access_tokens') {
        if (request.method !== 'POST' || !verifyJwt(request.headers.authorization))
          return json(401, { message: 'Bad credentials' });
        const installation = Number(parts[2]);
        const body = JSON.parse(request.body ?? '{}');
        const covered = options.repos.filter((repo) => repo.installation === installation);
        if (!covered.length) return notFound();
        const ids: number[] | undefined = body.repository_ids;
        if (ids && body.repositories) return json(422, { message: 'one of repositories or ids' });
        if (ids && ids.some((id) => !covered.some((repo) => repo.id === id)))
          return json(422, { message: 'repository not covered' });
        const names: string[] = ids
          ? ids.map((id) => covered.find((repo) => repo.id === id)!.name)
          : (body.repositories ?? []);
        if (!names.length || names.some((name) => !covered.some((repo) => repo.name === name)))
          return json(422, { message: 'repository not covered' });
        const token = `test-installation-token-${++tokenCounter}`;
        tokens.push({
          token,
          installation,
          repositories: names,
          ...(ids ? { repository_ids: ids } : {}),
          permissions: body.permissions,
        });
        return json(201, { token, expires_at: '2099-01-01T00:00:00Z' });
      }
      if (parts[0] !== 'repos') return notFound();
      const repo = options.repos.find(
        (item) =>
          item.owner.toLowerCase() === parts[1]?.toLowerCase() &&
          item.name.toLowerCase() === parts[2]?.toLowerCase(),
      );
      if (parts[3] === 'installation') {
        if (!verifyJwt(request.headers.authorization))
          return json(401, { message: 'Bad credentials' });
        return repo
          ? json(200, { id: repo.installation, account: { login: repo.owner } })
          : notFound();
      }
      if (!repo) return notFound();
      const token = tokenFor(request.headers.authorization, repo);
      if (!token) return notFound();
      const rest = parts.slice(3);
      if (rest.length === 0)
        return json(200, {
          id: repo.id,
          full_name: `${repo.owner}/${repo.name}`,
          default_branch: repo.default_branch,
          private: repo.private,
        });
      if (rest[0] === 'commits' && rest.length === 2) {
        const sha = resolve(repo, rest[1]!);
        return sha
          ? json(200, { sha, commit: { tree: { sha: treeSha(sha) } } })
          : json(422, { message: 'No commit found' });
      }
      if (rest[0] === 'contents') {
        const ref = url.searchParams.get('ref') ?? '';
        const commit = resolve(repo, ref);
        if (!commit) return notFound();
        const path = rest.slice(1).join('/');
        const files = repo.commits[commit]!;
        if (path in files) {
          const content = Buffer.from(files[path]!);
          // Like GitHub: a symlink whose target is a regular file in the repository is followed,
          // and the answer is the target file (with the target's path).
          const target = content.toString('utf8');
          if (repo.symlinks?.[commit]?.includes(path) && target in files)
            return json(200, {
              type: 'file',
              path: target,
              sha: blobSha(repo, commit, target),
              size: Buffer.byteLength(files[target]!),
              encoding: 'base64',
              content: Buffer.from(files[target]!).toString('base64'),
            });
          if (repo.symlinks?.[commit]?.includes(path))
            return json(200, {
              type: 'symlink',
              path,
              sha: blobSha(repo, commit, path),
              target: 'x',
            });
          const big = content.length > 1024 * 1024;
          return json(200, {
            type: 'file',
            path,
            sha: blobSha(repo, commit, path),
            size: content.length,
            encoding: big ? 'none' : 'base64',
            content: big ? '' : content.toString('base64'),
          });
        }
        const entries = listDir(repo, commit, path);
        return entries.length || path === '' ? json(200, entries) : notFound();
      }
      if (rest[0] === 'git' && rest[1] === 'trees' && request.method === 'GET') {
        let commit: string | undefined;
        let dir = '';
        for (const sha of Object.keys(repo.commits)) {
          if (treeSha(sha) === rest[2]) commit = sha;
          for (const file of Object.keys(repo.commits[sha]!)) {
            const segments = file.split('/');
            for (let i = 1; i < segments.length; i++) {
              const candidate = segments.slice(0, i).join('/');
              if (dirSha(sha, candidate) === rest[2]) {
                commit = sha;
                dir = candidate;
              }
            }
          }
        }
        if (!commit) return notFound();
        const recursive = url.searchParams.get('recursive') === '1';
        const prefix = dir ? `${dir}/` : '';
        const dirs = new Set<string>();
        const tree: Record<string, unknown>[] = [];
        for (const file of Object.keys(repo.commits[commit]!).sort()) {
          if (!file.startsWith(prefix)) continue;
          const relative = file.slice(prefix.length);
          const segments = relative.split('/');
          for (let i = 1; i < segments.length; i++) dirs.add(segments.slice(0, i).join('/'));
          if (!recursive && segments.length > 1) continue;
          tree.push({
            path: relative,
            type: 'blob',
            mode: repo.symlinks?.[commit]?.includes(file)
              ? '120000'
              : repo.executables?.includes(file)
                ? '100755'
                : '100644',
            sha: blobSha(repo, commit, file),
            size: Buffer.byteLength(repo.commits[commit]![file]!),
          });
        }
        for (const relative of dirs)
          if (recursive || !relative.includes('/'))
            tree.push({
              path: relative,
              type: 'tree',
              mode: '040000',
              sha: dirSha(commit, `${prefix}${relative}`),
            });
        return json(200, { sha: rest[2], tree, truncated: false });
      }
      if (request.method === 'POST' && rest[0] === 'git') {
        const body = JSON.parse(request.body ?? '{}');
        if (rest[1] === 'blobs') {
          const sha = sha40(`newblob:${body.content}`);
          writes.blobs.set(sha, Buffer.from(body.content, 'base64').toString('utf8'));
          return json(201, { sha });
        }
        if (rest[1] === 'trees') {
          // Content-addressed, like git: the same base and entries give the same tree.
          const sha = sha40(`tree:${JSON.stringify([body.base_tree, body.tree])}`);
          writes.trees.set(sha, { base_tree: body.base_tree, tree: body.tree });
          return json(201, { sha });
        }
        if (rest[1] === 'commits') {
          const sha = newSha('commit');
          writes.commits.set(sha, {
            message: body.message,
            tree: body.tree,
            parents: body.parents,
          });
          return json(201, { sha });
        }
        if (rest[1] === 'refs') {
          if (
            writes.refs.has(body.ref) ||
            repo.branches[String(body.ref).replace('refs/heads/', '')]
          )
            return json(422, { message: 'Reference already exists' });
          writes.refs.set(body.ref, body.sha);
          return json(201, { ref: body.ref, object: { sha: body.sha } });
        }
      }
      if (rest[0] === 'git' && rest[1] === 'commits' && request.method === 'GET') {
        const commit = writes.commits.get(rest[2]!);
        if (commit)
          return json(200, {
            sha: rest[2],
            tree: { sha: commit.tree },
            parents: commit.parents.map((sha) => ({ sha })),
          });
        if (repo.commits[rest[2]!])
          return json(200, { sha: rest[2], tree: { sha: treeSha(rest[2]!) }, parents: [] });
        return notFound();
      }
      if (rest[0] === 'git' && rest[1] === 'ref' && request.method === 'GET') {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const sha = writes.refs.get(ref);
        return sha ? json(200, { ref, object: { sha } }) : notFound();
      }
      if (rest[0] === 'pulls' && rest.length === 1 && request.method === 'POST') {
        const body = JSON.parse(request.body ?? '{}');
        const headSha = writes.refs.get(`refs/heads/${body.head}`);
        if (!headSha) return json(422, { message: 'head not found' });
        if (writes.pulls.some((pull) => pull.head.ref === body.head && pull.state === 'open'))
          return json(422, { message: 'A pull request already exists' });
        const pull: FakePull = {
          number: 100 + writes.pulls.length + 1,
          html_url: `https://github.test/${repo.owner}/${repo.name}/pull/${101 + writes.pulls.length}`,
          state: 'open',
          merged: false,
          draft: body.draft === true,
          title: body.title,
          body: body.body,
          base: body.base,
          head: { ref: body.head, sha: headSha },
        };
        writes.pulls.push(pull);
        return json(201, pull);
      }
      if (rest[0] === 'pulls' && rest.length === 1 && request.method === 'GET') {
        const head = url.searchParams.get('head') ?? '';
        const branch = head.slice(head.indexOf(':') + 1);
        return json(
          200,
          writes.pulls.filter((pull) => pull.head.ref === branch),
        );
      }
      if (rest[0] === 'pulls' && rest.length === 2 && request.method === 'GET') {
        const pull = writes.pulls.find((item) => item.number === Number(rest[1]));
        return pull ? json(200, pull) : notFound();
      }
      const page = (items: Record<string, unknown>[]) => {
        const n = Number(url.searchParams.get('page') ?? '1');
        const size = Number(url.searchParams.get('per_page') ?? '30');
        return { total_count: items.length, items: items.slice((n - 1) * size, n * size) };
      };
      if (rest[0] === 'commits' && rest[2] === 'check-runs') {
        const { total_count, items } = page(fake.checks[rest[1]!] ?? []);
        return json(200, { total_count, check_runs: items });
      }
      if (rest[0] === 'commits' && rest[2] === 'status') {
        const { total_count, items } = page(fake.statuses[rest[1]!] ?? []);
        return json(200, { total_count, statuses: items });
      }
      if (rest[0] === 'git' && rest[1] === 'blobs') {
        const content = blobs.get(rest[2]!);
        return content
          ? json(200, {
              sha: rest[2],
              encoding: 'base64',
              content: content.toString('base64'),
              size: content.length,
            })
          : notFound();
      }
      return notFound();
    },
  };
  return fake;
}

/** A deterministic synthetic 40-hex commit sha. */
export const commitSha = (seed: string) => sha40(`commit:${seed}`);
