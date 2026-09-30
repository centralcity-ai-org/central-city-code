import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

/*
 * scripts/check-boundaries.mjs keeps secret files and secret-shaped content out of src, public
 * and dist. Secret-shaped samples are assembled at run time from harmless pieces, so no such
 * literal appears in this file.
 */

const load = async () =>
  (await import(pathToFileURL(resolve('scripts/check-boundaries.mjs')).href)) as {
    isSecretFilename(path: string): boolean;
    hasSecretContent(text: string): boolean;
    checkBoundaries(roots?: string[]): Promise<{ checked: number; violations: string[] }>;
  };

test('secret file names are refused; example files are allowed', async () => {
  const { isSecretFilename } = await load();
  for (const path of ['.env', 'src/.env.production', 'public/server.pem', 'dist/id.key', 'a/b.p12'])
    assert.ok(isSecretFilename(path), path);
  for (const path of ['.env.example', 'src/env.ts', 'public/keyboard.svg', 'docs/KEYS.md'])
    assert.ok(!isSecretFilename(path), path);
});

test('secret-shaped content is refused', async () => {
  const { hasSecretContent } = await load();
  const dashes = '-'.repeat(5);
  assert.ok(hasSecretContent(`${dashes}BEGIN ${'PRIVATE'} KEY${dashes}`));
  assert.ok(hasSecretContent(`${dashes}BEGIN RSA ${'PRIVATE'} KEY${dashes}`));
  assert.ok(hasSecretContent(`id ${['AK', 'IA'].join('')}${'A'.repeat(16)}`));
  assert.ok(!hasSecretContent('A public key starts with BEGIN PUBLIC KEY.'));
  assert.ok(!hasSecretContent('An access key id looks like AKIA followed by 16 characters.'));
});

test('the scan reports secret files and content under the given roots', async () => {
  const { checkBoundaries } = await load();
  const root = mkdtempSync(join(tmpdir(), 'cc-boundaries-'));
  try {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = true;\n');
    let result = await checkBoundaries([join(root, 'src')]);
    assert.deepEqual(result.violations, []);
    assert.equal(result.checked, 1);

    writeFileSync(join(root, 'src', '.env'), 'NAME=value\n');
    const dashes = '-'.repeat(5);
    writeFileSync(join(root, 'src', 'leak.ts'), `// ${dashes}BEGIN EC ${'PRIVATE'} KEY${dashes}\n`);
    result = await checkBoundaries([join(root, 'src'), join(root, 'missing')]);
    assert.equal(result.violations.length, 2);
    assert.ok(result.violations.some((line) => line.endsWith('.env: secret file name')));
    assert.ok(result.violations.some((line) => line.endsWith('leak.ts: private key pattern')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
