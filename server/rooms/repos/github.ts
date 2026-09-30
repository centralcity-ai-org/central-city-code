import { createPrivateKey, sign, type KeyObject } from 'node:crypto';

/**
 * GitHub App client for room repos (docs/ROOM_REPOS.md).
 *
 * - The app authenticates with a short-lived RS256 JWT signed with the App private key from the
 *   environment (`CITY_GITHUB_APP_PRIVATE_KEY`). The key is parsed once and never logged.
 * - Every operation mints its own installation access token, restricted to the one bound
 *   repository and to the permission subset that operation needs (read-only for reads). Tokens
 *   are never stored, cached or logged; GitHub expires them within an hour anyway.
 * - All HTTP goes through an injected `GitHubTransport`, so tests use a fake GitHub and never
 *   touch the network.
 * - Ref creation has a single entry point (`createOwnRef`) that refuses anything outside
 *   `refs/heads/cc/…`. There is no merge, force-update or ref deletion anywhere in this client.
 *
 * GitHub response bodies are untrusted data: they are parsed as JSON, and only the fields the
 * room tools need are copied out. Error messages never include response bodies or tokens.
 */

export const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';
/** Response bodies above this are refused (the contents API returns at most ~1.4 MB of JSON). */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
/** Check runs and statuses are read up to this many pages of 100. */
const CHECK_PAGES = 10;

export interface GitHubRequest {
  method: 'GET' | 'POST' | 'PATCH';
  /** Path under the API root, starting with `/`. */
  path: string;
  headers: Record<string, string>;
  body?: string;
}
export interface GitHubResponse {
  status: number;
  body: string;
}
export type GitHubTransport = (request: GitHubRequest) => Promise<GitHubResponse>;

/** The production transport: `fetch` to api.github.com with a timeout and a size cap. */
export const fetchTransport: GitHubTransport = async (request) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API}${request.path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'error',
      signal: controller.signal,
    });
    const length = Number(res.headers.get('content-length') ?? '0');
    if (length > MAX_RESPONSE_BYTES) {
      await res.body?.cancel();
      return { status: 413, body: '' };
    }
    // Streamed with a running total, so a body without content-length stops at the cap.
    const chunks: Buffer[] = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          return { status: 413, body: '' };
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { status: res.status, body: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timer);
  }
};

/** A GitHub failure mapped to a stable code; `status` is GitHub's HTTP status (0 = network). */
export class GitHubError extends Error {
  constructor(
    public status: number,
    public code:
      | 'not_found'
      | 'forbidden'
      | 'unauthorized'
      | 'conflict'
      | 'unprocessable'
      | 'rate_limited'
      | 'too_large'
      | 'unavailable',
  ) {
    super(`GitHub request failed (${code}).`);
  }
}

function codeFor(status: number): GitHubError['code'] {
  if (status === 404) return 'not_found';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 422) return 'unprocessable';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

/** Permissions a room operation may ask an installation token for (a subset of the App's). */
export type TokenPermissions = Partial<{
  contents: 'read' | 'write';
  metadata: 'read';
  pull_requests: 'read' | 'write';
  checks: 'read';
  statuses: 'read';
}>;
export const READ_PERMISSIONS: TokenPermissions = { contents: 'read', metadata: 'read' };

export interface GitHubAppConfig {
  appId: string;
  /** PEM text; literal `\n` escapes (as some env editors store them) are accepted. */
  privateKey: string;
}

/** Parses the App key once. Throws a message without key material on a malformed key. */
export function parseAppKey(pem: string): KeyObject {
  const text = pem.includes('\\n') ? pem.replace(/\\n/g, '\n') : pem;
  try {
    const key = createPrivateKey({ key: text, format: 'pem' });
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not rsa');
    return key;
  } catch {
    throw new Error('CITY_GITHUB_APP_PRIVATE_KEY is not a valid RSA private key (PEM).');
  }
}

const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');

/** RS256 App JWT: issued 60 s in the past (clock skew), valid 9 minutes (GitHub allows 10). */
export function appJwt(appId: string, key: KeyObject, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

/** `owner/name` as GitHub allows it (letters, digits, `-`, `_`, `.`), never `.`/`..`. */
export const REPO_FULL_NAME = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * The only refs this App ever creates: `refs/heads/cc/<room-slug>/p<n>-r<rev>`. Contents-write
 * would technically allow any ref, so this guard is the single gate (docs/ROOM_REPOS.md).
 */
export const OWN_REF =
  /^refs\/heads\/cc\/[a-z0-9][a-z0-9-]{0,63}\/p[1-9][0-9]{0,8}-r[1-9][0-9]{0,4}$/;
export function assertOwnRef(ref: string): void {
  if (!OWN_REF.test(ref)) throw new Error('Refusing to create a ref outside refs/heads/cc/.');
}

const path = (...parts: string[]) => parts.map((part) => encodeURIComponent(part)).join('/');
/** Encodes a repo file path segment by segment (slashes kept). */
export const encodePath = (file: string) =>
  file
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

export interface RepoInfo {
  id: number;
  full_name: string;
  default_branch: string;
  private: boolean;
}
export interface CommitInfo {
  sha: string;
  tree_sha: string;
}
export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  mode: string;
  sha: string;
  size?: number;
}
export type ContentsResult =
  | { kind: 'dir'; entries: TreeEntry[] }
  | {
      kind: 'file';
      path: string;
      sha: string;
      size: number;
      /** Raw bytes; null when GitHub did not inline them (files over 1 MB). */
      bytes: Buffer | null;
    }
  | { kind: 'other'; path: string; type: string; sha: string };

/** A repo-scoped handle for one operation; holds its token only for the operation's lifetime. */
export interface RepoSession {
  repo(): Promise<RepoInfo>;
  /** Resolves a branch, tag or SHA to its commit. */
  commit(ref: string): Promise<CommitInfo>;
  /** The tree of a commit's root tree SHA (optionally recursive). */
  tree(treeSha: string, recursive: boolean): Promise<{ entries: TreeEntry[]; truncated: boolean }>;
  /** A file or directory at an exact commit SHA. */
  contents(filePath: string, commitSha: string): Promise<ContentsResult>;
  /** A blob's raw bytes by SHA (for files over 1 MB, still subject to the caller's caps). */
  blob(sha: string): Promise<Buffer>;
  /** Creates `refs/heads/cc/…` only; see `assertOwnRef`. */
  createOwnRef(ref: string, sha: string): Promise<void>;
  /** The commit an own `refs/heads/cc/…` ref points at, or null when it does not exist. */
  ownRef(ref: string): Promise<string | null>;
  /** Creates a blob from UTF-8 text; returns its SHA. */
  createBlob(content: string): Promise<string>;
  /** Creates a tree on `baseTree`; `sha: null` deletes the path. */
  createTree(
    baseTree: string,
    entries: { path: string; mode: '100644' | '100755'; sha: string | null }[],
  ): Promise<string>;
  /** Creates a commit (author and committer: the App) with exactly one parent. */
  createCommit(message: string, tree: string, parent: string): Promise<string>;
  /** Opens a **draft** pull request from an own `cc/` branch. Never merges. */
  createDraftPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<PullInfo>;
  /** The pull request whose head is this own branch, if any (any state). */
  pullForBranch(branch: string): Promise<PullInfo | null>;
  pull(number: number): Promise<PullInfo>;
  /** A commit object by SHA: its tree and parents (to verify an existing own branch). */
  gitCommit(sha: string): Promise<{ tree: string; parents: string[] }>;
  /** Every check run on a commit, paged; `complete` is false past the page cap. */
  checkRuns(sha: string): Promise<{ results: CheckResult[]; complete: boolean }>;
  /** Every commit status on a commit, paged; `complete` is false past the page cap. */
  statuses(sha: string): Promise<{ results: CheckResult[]; complete: boolean }>;
}

export interface PullInfo {
  number: number;
  url: string;
  head_sha: string;
  head_ref: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
}
/** One check run or commit status exactly as read from GitHub (normalized field names). */
export interface CheckResult {
  source: 'check_run' | 'status';
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'pending';
  conclusion: string | null;
  url: string | null;
}

export interface GitHubApp {
  /** The installation that covers `owner/repo`, via the App JWT (404 when not covered). */
  installationFor(fullName: string): Promise<{ id: number; account_login: string }>;
  /**
   * Mints a token for one repository with exactly these permissions and returns a session. Bound
   * repositories are addressed by their immutable id (`repository_ids`), so a renamed,
   * transferred or re-created repository with the same name is never reached; the name form is
   * used only while binding, before the id is known.
   */
  session(
    installationId: number,
    repository: { id: number } | { name: string },
    fullName: string,
    permissions: TokenPermissions,
  ): Promise<RepoSession>;
}

function parse<T>(body: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new GitHubError(502, 'unavailable');
  }
}

export function createGitHubApp(
  config: GitHubAppConfig,
  transport: GitHubTransport = fetchTransport,
  clock: () => number = Date.now,
): GitHubApp {
  const key = parseAppKey(config.privateKey);
  const appId = config.appId;
  const base = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': 'central-city-rooms',
  };

  async function call<T>(
    authorization: string,
    method: GitHubRequest['method'],
    route: string,
    body?: unknown,
  ): Promise<T> {
    let res: GitHubResponse;
    try {
      res = await transport({
        method,
        path: route,
        headers: {
          ...base,
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new GitHubError(0, 'unavailable');
    }
    if (res.status < 200 || res.status >= 300)
      throw new GitHubError(res.status, codeFor(res.status));
    return parse<T>(res.body);
  }
  const asApp = <T>(method: GitHubRequest['method'], route: string, body?: unknown) =>
    call<T>(`Bearer ${appJwt(appId, key, clock())}`, method, route, body);

  return {
    async installationFor(fullName) {
      if (!REPO_FULL_NAME.test(fullName)) throw new GitHubError(404, 'not_found');
      const [owner, name] = fullName.split('/') as [string, string];
      const found = await asApp<{ id: number; account?: { login?: string } }>(
        'GET',
        `/repos/${path(owner, name)}/installation`,
      );
      if (!Number.isSafeInteger(found.id)) throw new GitHubError(502, 'unavailable');
      return { id: found.id, account_login: String(found.account?.login ?? owner) };
    },

    async session(installationId, repository, fullName, permissions) {
      if (!REPO_FULL_NAME.test(fullName)) throw new GitHubError(404, 'not_found');
      const minted = await asApp<{ token?: unknown }>(
        'POST',
        `/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
        'id' in repository
          ? { repository_ids: [repository.id], permissions }
          : { repositories: [repository.name], permissions },
      );
      if (typeof minted.token !== 'string' || !minted.token)
        throw new GitHubError(502, 'unavailable');
      const auth = `token ${minted.token}`;
      const [owner, name] = fullName.split('/') as [string, string];
      const repoPath = `/repos/${path(owner, name)}`;
      const get = <T>(route: string) => call<T>(auth, 'GET', `${repoPath}${route}`);
      return {
        async repo() {
          const r = await get<{
            id: number;
            full_name: string;
            default_branch: string;
            private: boolean;
          }>('');
          return {
            id: Number(r.id),
            full_name: String(r.full_name),
            default_branch: String(r.default_branch),
            private: Boolean(r.private),
          };
        },
        async commit(ref) {
          // GitHub answers an unknown ref here with 422 ("No commit found"), not 404.
          const c = await get<{ sha: string; commit?: { tree?: { sha?: string } } }>(
            `/commits/${encodeURIComponent(ref)}`,
          ).catch((error: unknown) => {
            if (error instanceof GitHubError && error.code === 'unprocessable')
              throw new GitHubError(404, 'not_found');
            throw error;
          });
          const treeSha = c.commit?.tree?.sha;
          if (typeof c.sha !== 'string' || typeof treeSha !== 'string')
            throw new GitHubError(502, 'unavailable');
          return { sha: c.sha, tree_sha: treeSha };
        },
        async tree(treeSha, recursive) {
          const t = await get<{ tree: TreeEntry[]; truncated?: boolean }>(
            `/git/trees/${encodeURIComponent(treeSha)}${recursive ? '?recursive=1' : ''}`,
          );
          return {
            entries: (Array.isArray(t.tree) ? t.tree : []).map(entry),
            truncated: Boolean(t.truncated),
          };
        },
        async contents(filePath, commitSha) {
          const route = `/contents/${encodePath(filePath)}?ref=${encodeURIComponent(commitSha)}`;
          const c = await get<unknown>(
            filePath ? route : `/contents?ref=${encodeURIComponent(commitSha)}`,
          );
          if (Array.isArray(c))
            return {
              kind: 'dir',
              entries: c.map((item: Record<string, unknown>) =>
                entry({
                  path: String(item.path),
                  type:
                    item.type === 'dir' ? 'tree' : item.type === 'submodule' ? 'commit' : 'blob',
                  mode:
                    item.type === 'symlink' ? '120000' : item.type === 'dir' ? '040000' : '100644',
                  sha: String(item.sha),
                  size: Number(item.size),
                }),
              ),
            };
          const item = c as Record<string, unknown>;
          if (item.type !== 'file')
            return {
              kind: 'other',
              path: String(item.path),
              type: String(item.type),
              sha: String(item.sha),
            };
          const inline = item.encoding === 'base64' && typeof item.content === 'string';
          return {
            kind: 'file',
            path: String(item.path),
            sha: String(item.sha),
            size: Number(item.size),
            bytes: inline ? Buffer.from(item.content as string, 'base64') : null,
          };
        },
        async blob(sha) {
          const b = await get<{ content?: unknown; encoding?: unknown }>(
            `/git/blobs/${encodeURIComponent(sha)}`,
          );
          if (b.encoding !== 'base64' || typeof b.content !== 'string')
            throw new GitHubError(502, 'unavailable');
          return Buffer.from(b.content, 'base64');
        },
        async createOwnRef(ref, commitSha) {
          assertOwnRef(ref);
          if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('A ref needs a full commit SHA.');
          await call(auth, 'POST', `${repoPath}/git/refs`, { ref, sha: commitSha });
        },
        async ownRef(ref) {
          assertOwnRef(ref);
          try {
            const found = await get<{ ref?: string; object?: { sha?: string } }>(
              `/git/ref/${encodePath(ref.slice('refs/'.length))}`,
            );
            return found.ref === ref && typeof found.object?.sha === 'string'
              ? found.object.sha
              : null;
          } catch (error) {
            if (error instanceof GitHubError && error.code === 'not_found') return null;
            throw error;
          }
        },
        async createBlob(content) {
          const blob = await call<{ sha?: string }>(auth, 'POST', `${repoPath}/git/blobs`, {
            content: Buffer.from(content, 'utf8').toString('base64'),
            encoding: 'base64',
          });
          return fullSha(blob.sha);
        },
        async createTree(baseTree, entries) {
          const tree = await call<{ sha?: string }>(auth, 'POST', `${repoPath}/git/trees`, {
            base_tree: baseTree,
            tree: entries.map((item) => ({
              path: item.path,
              mode: item.mode,
              type: 'blob',
              sha: item.sha,
            })),
          });
          return fullSha(tree.sha);
        },
        async createCommit(message, tree, parent) {
          const commit = await call<{ sha?: string }>(auth, 'POST', `${repoPath}/git/commits`, {
            message,
            tree,
            parents: [parent],
          });
          return fullSha(commit.sha);
        },
        async createDraftPull(input) {
          assertOwnRef(`refs/heads/${input.head}`);
          const pr = await call<RawPull>(auth, 'POST', `${repoPath}/pulls`, {
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
            draft: true,
            maintainer_can_modify: false,
          });
          return pullOf(pr);
        },
        async pullForBranch(branch) {
          assertOwnRef(`refs/heads/${branch}`);
          const list = await get<RawPull[]>(
            `/pulls?state=all&per_page=5&head=${encodeURIComponent(`${owner}:${branch}`)}`,
          );
          const found = (Array.isArray(list) ? list : []).find((item) => item.head?.ref === branch);
          return found ? pullOf(found) : null;
        },
        async pull(number) {
          return pullOf(await get<RawPull>(`/pulls/${encodeURIComponent(String(number))}`));
        },
        async gitCommit(commitSha) {
          const commit = await get<{ tree?: { sha?: string }; parents?: { sha?: string }[] }>(
            `/git/commits/${encodeURIComponent(commitSha)}`,
          );
          return {
            tree: fullSha(commit.tree?.sha),
            parents: (commit.parents ?? []).map((parent) => fullSha(parent.sha)),
          };
        },
        async checkRuns(commitSha) {
          const results: CheckResult[] = [];
          for (let page = 1; page <= CHECK_PAGES; page++) {
            const runs = await get<{
              total_count?: number;
              check_runs?: Record<string, unknown>[];
            }>(`/commits/${encodeURIComponent(commitSha)}/check-runs?per_page=100&page=${page}`);
            const batch = runs.check_runs ?? [];
            for (const run of batch)
              results.push({
                source: 'check_run' as const,
                name: String(run.name ?? ''),
                status: (['queued', 'in_progress', 'completed'].includes(String(run.status))
                  ? run.status
                  : 'queued') as CheckResult['status'],
                conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
                url: typeof run.html_url === 'string' ? run.html_url : null,
              });
            const total = Number(runs.total_count ?? results.length);
            if (batch.length < 100 || results.length >= total) return { results, complete: true };
          }
          return { results, complete: false };
        },
        async statuses(commitSha) {
          const results: CheckResult[] = [];
          for (let page = 1; page <= CHECK_PAGES; page++) {
            const combined = await get<{
              total_count?: number;
              statuses?: Record<string, unknown>[];
            }>(`/commits/${encodeURIComponent(commitSha)}/status?per_page=100&page=${page}`);
            const batch = combined.statuses ?? [];
            for (const status of batch)
              results.push({
                source: 'status' as const,
                name: String(status.context ?? ''),
                status: status.state === 'pending' ? ('pending' as const) : ('completed' as const),
                conclusion: status.state === 'pending' ? null : String(status.state ?? ''),
                url: typeof status.target_url === 'string' ? status.target_url : null,
              });
            const total = Number(combined.total_count ?? results.length);
            if (batch.length < 100 || results.length >= total) return { results, complete: true };
          }
          return { results, complete: false };
        },
      };
    },
  };
}

interface RawPull {
  number?: number;
  html_url?: string;
  state?: string;
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  head?: { sha?: string; ref?: string };
}
function pullOf(raw: RawPull): PullInfo {
  if (!Number.isSafeInteger(raw.number) || typeof raw.head?.sha !== 'string')
    throw new GitHubError(502, 'unavailable');
  return {
    number: raw.number!,
    url: String(raw.html_url ?? ''),
    head_sha: raw.head.sha,
    head_ref: String(raw.head.ref ?? ''),
    state: raw.state === 'closed' ? 'closed' : 'open',
    merged: Boolean(raw.merged ?? raw.merged_at),
    draft: Boolean(raw.draft),
  };
}
function fullSha(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value))
    throw new GitHubError(502, 'unavailable');
  return value;
}

function entry(raw: TreeEntry): TreeEntry {
  const type = raw.type === 'tree' || raw.type === 'commit' ? raw.type : 'blob';
  return {
    path: String(raw.path),
    type,
    mode: String(raw.mode),
    sha: String(raw.sha),
    ...(type === 'blob' && Number.isFinite(Number(raw.size)) ? { size: Number(raw.size) } : {}),
  };
}
