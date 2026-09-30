import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import {
  claim,
  DEFAULT_E2E_PORT,
  e2eOrigin,
  lockPath,
  probe,
  release,
  resolveE2EPort,
} from './port';

const listen = (port: number) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(server));
  });

test('this run resolved one port, and the specs and the server agree on it', async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBe(e2eOrigin());
  expect((await page.request.get('/api/session')).ok()).toBe(true);
});

test('E2E_PORT=<number> is used as given; invalid values are rejected', async () => {
  const env: NodeJS.ProcessEnv = { E2E_PORT: '4555' };
  expect(await resolveE2EPort(env)).toBe(4555);
  await expect(resolveE2EPort({ E2E_PORT: 'eighty' })).rejects.toThrow(/E2E_PORT/);
  await expect(resolveE2EPort({ E2E_PORT: '70000' })).rejects.toThrow(/E2E_PORT/);
});

test('E2E_PORT=auto takes a free OS port and records it for the workers', async () => {
  const env: NodeJS.ProcessEnv = { E2E_PORT: 'auto' };
  const port = await resolveE2EPort(env);
  expect(port).toBeGreaterThan(0);
  expect(env.E2E_PORT).toBe(String(port));
  expect(await probe(port)).toBe(port); // released again, so the server can bind it
});

test('unset: 4311 when free, otherwise a different free port', async () => {
  const blocker = await listen(0);
  const busy = (blocker.address() as { port: number }).port;
  expect(await probe(busy)).toBeNull();
  blocker.close();
  const env: NodeJS.ProcessEnv = {};
  const port = await resolveE2EPort(env);
  expect(env.E2E_PORT).toBe(String(port));
  // While this run's server holds its port, 4311 is taken whenever this run uses it.
  if (Number(process.env.E2E_PORT) === DEFAULT_E2E_PORT) expect(port).not.toBe(DEFAULT_E2E_PORT);
});

test('a port locked by another live run is skipped; a stale lock is reclaimed', async () => {
  const blocker = await listen(0);
  const port = (blocker.address() as { port: number }).port; // a port no other run will claim
  blocker.close();
  expect(claim(port, process.ppid)).toBe(true); // held by a live process (the runner)
  expect(claim(port)).toBe(false);
  release(port, process.ppid);
  writeFileSync(lockPath(port), '999999999'); // a run that no longer exists
  expect(claim(port)).toBe(true);
  release(port);
});
