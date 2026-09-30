import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * The e2e server port (playwright.config.ts). Parallel runs on one machine (several agents,
 * several worktrees) must never share a port:
 * - E2E_PORT=<number> uses that port;
 * - E2E_PORT=auto takes a free port from the OS;
 * - unset, 4311 is used when it is free (CI and the docs stay unchanged), otherwise a free port
 *   from the OS.
 * The first resolution (in the Playwright runner) writes E2E_PORT back into process.env, so the
 * workers, which load the config again, inherit the same port instead of choosing their own.
 * A probe alone is racy: two runs started together can both see 4311 free before either server
 * binds it. So a chosen port is also claimed with a lock file (created exclusively, holding the
 * runner's pid, removed when the runner exits; a lock whose pid is gone counts as stale).
 */
export const DEFAULT_E2E_PORT = 4311;
const host = '127.0.0.1';

/** Binds `port` on the server's host and releases it; resolves to the bound port or null. */
export function probe(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(null));
    server.listen({ host, port, exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : null;
      server.close(() => resolve(bound));
    });
  });
}

export function lockPath(port: number) {
  return join(tmpdir(), `central-city-e2e-port-${port}.lock`);
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Claims `port` for this process until it exits; false when another live run holds it. */
export function claim(port: number, pid = process.pid): boolean {
  const path = lockPath(port);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, String(pid));
      closeSync(fd);
      process.once('exit', () => release(port, pid));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = NaN;
      try {
        holder = Number(readFileSync(path, 'utf8'));
      } catch {
        continue; // removed meanwhile; try again
      }
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) return false;
      try {
        unlinkSync(path); // stale: its run is gone
      } catch {
        /* another run removed it first */
      }
    }
  }
  return false;
}

/** Removes the lock for `port` if `pid` holds it. */
export function release(port: number, pid = process.pid) {
  try {
    if (readFileSync(lockPath(port), 'utf8') === String(pid)) unlinkSync(lockPath(port));
  } catch {
    /* already gone */
  }
}

/** A port that is free now and claimed by this run, or null. */
async function take(port: number): Promise<number | null> {
  if (port !== 0 && !claim(port)) return null;
  const bound = await probe(port);
  if (port === 0 && bound !== null && !claim(bound)) return null;
  if (bound === null && port !== 0) release(port);
  return bound;
}

export async function resolveE2EPort(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const requested = env.E2E_PORT?.trim();
  if (requested && requested !== 'auto') {
    const port = Number(requested);
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error(`E2E_PORT must be a port number or "auto", got "${requested}"`);
    return port;
  }
  let port = requested !== 'auto' ? await take(DEFAULT_E2E_PORT) : null;
  for (let attempt = 0; port === null && attempt < 5; attempt += 1) port = await take(0);
  if (!port) throw new Error('Could not find a free port for the e2e server');
  if (port !== DEFAULT_E2E_PORT)
    console.log(`e2e: port ${DEFAULT_E2E_PORT} is busy or E2E_PORT=auto; using port ${port}`);
  env.E2E_PORT = String(port);
  return port;
}

/** The origin specs use for absolute URLs, set by playwright.config.ts before any spec loads. */
export function e2eOrigin(env: NodeJS.ProcessEnv = process.env) {
  const port = env.E2E_PORT;
  if (!port || !/^\d+$/.test(port))
    throw new Error('E2E_PORT is not resolved; run through playwright.config.ts');
  return `http://${host}:${port}`;
}
