import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import { GOOGLE_SALT_NO_PASSWORD, GOOGLE_SALT_PENDING_NAME } from '../server/google/routes.js';
import { backupDatabase, restoreDatabase } from '../server/recovery.js';
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  claimsFor,
  fakeGoogle,
  signIdToken,
} from './fake-google.js';

/**
 * Accounts created with Google (no password) keep the offline backup valid: a backup with one
 * that chose its name and one that has not restores both, unchanged (server/recovery.ts).
 */
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };

test('backup and restore round-trip with Google-only accounts', async (t) => {
  const base = resolve(process.env.CC_RECOVERY_TEST_ROOT ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'city-google-backup-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(`${base}${sep}`));
    await rm(root, { recursive: true, force: true });
  });
  const source = join(root, 'source');
  const google = fakeGoogle();
  const app = await createApp({
    dataDir: source,
    startWorkers: false,
    google: {
      env: {
        CITY_GOOGLE_SIGNIN: '1',
        GOOGLE_OAUTH_CLIENT_ID: FAKE_CLIENT_ID,
        GOOGLE_OAUTH_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      },
      transport: google.transport,
    },
  });
  const signUp = async (sub: string) => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/auth/google/start',
      headers,
      payload: JSON.stringify({ intent: 'signin' }),
    });
    const params = new URL(started.json().url).searchParams;
    const binder = started.cookies.find((item) => item.name === 'cc_google_flow')!.value;
    const token = signIdToken(
      google.keys[0]!,
      claimsFor(params.get('nonce')!, Date.now(), { sub, email: `backup.${sub}@example.com` }),
    );
    const code = google.issueCode(token, params.get('code_challenge')!);
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/google/callback?${new URLSearchParams({ state: params.get('state')!, code })}`,
      headers: { cookie: `cc_google_flow=${binder}` },
    });
    assert.equal(res.headers.location, '/settings/account?google=welcome');
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const named = await signUp('100000000000000000071');
  await signUp('100000000000000000072');
  const saved = await app.inject({
    method: 'POST',
    url: '/api/auth/google/handle',
    headers: { ...headers, cookie: named },
    payload: JSON.stringify({ name: 'Backup Googler' }),
  });
  assert.equal(saved.statusCode, 200, saved.body);
  const query =
    'SELECT id,name,name_key,password_hash,salt FROM operators WHERE kind=$1 ORDER BY id';
  const before = (await app.city.db.query(query, ['owner'])).rows;
  assert.deepEqual(
    before.map((row) => row.salt).sort(),
    [GOOGLE_SALT_NO_PASSWORD, GOOGLE_SALT_PENDING_NAME].sort(),
  );
  await app.close();

  const backup = join(root, 'snapshot.json');
  await backupDatabase(source, backup);
  const restoredPath = join(root, 'restored');
  await restoreDatabase(backup, restoredPath);
  const restored = await createApp({ dataDir: restoredPath, startWorkers: false });
  try {
    assert.deepEqual((await restored.city.db.query(query, ['owner'])).rows, before);
  } finally {
    await restored.close();
  }
});
