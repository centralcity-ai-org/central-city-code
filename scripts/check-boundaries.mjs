import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Keeps secrets out of the application and its build output.
 *
 * `src`, `public` and the compiled `dist` are scanned for files that should never be published
 * (environment files, private keys, certificates and key stores) and for secret-shaped content
 * (AWS access key ids and PEM private key blocks). In a Git checkout, every tracked file name is
 * checked the same way, so such a file cannot be committed anywhere in the repository.
 */

/** File names that hold secrets. Example files such as `.env.example` are allowed. */
export const SECRET_FILENAME = /^\.env(?:\..+)?$|\.(?:pem|key|p12|pfx|jks|keystore)$/i;
export const ALLOWED_FILENAME = /^\.env\.(?:example|sample|template)$/i;

/** Secret-shaped content. */
export const SECRET_CONTENT =
  /\bAKIA[A-Z0-9]{16}\b|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

const TEXT_FILE = /\.(?:tsx?|jsx?|mjs|cjs|html|css|json|md|txt|map|ya?ml|toml)$/i;

export function isSecretFilename(path) {
  const name = basename(path);
  return SECRET_FILENAME.test(name) && !ALLOWED_FILENAME.test(name);
}

export function hasSecretContent(text) {
  return SECRET_CONTENT.test(text);
}

export async function checkBoundaries(roots = ['src', 'public', 'dist']) {
  const violations = [];
  let checked = 0;
  async function scan(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(file);
        continue;
      }
      checked++;
      if (isSecretFilename(file)) violations.push(`${file}: secret file name`);
      if (!TEXT_FILE.test(file)) continue;
      if (hasSecretContent(await readFile(file, 'utf8')))
        violations.push(`${file}: private key pattern`);
    }
  }
  for (const root of roots) await scan(root);
  return { checked, violations };
}

/** Tracked files with a secret file name, or null outside a Git checkout. */
export function trackedSecretFiles(cwd = process.cwd()) {
  let listing;
  try {
    listing = execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' });
  } catch {
    return null;
  }
  return listing.split('\0').filter((path) => path && isSecretFilename(path));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { checked, violations } = await checkBoundaries();
  const tracked = trackedSecretFiles();
  for (const path of tracked ?? []) violations.push(`${path}: tracked secret file name`);
  if (violations.length) throw new Error(violations.join('\n'));
  console.log(`Boundary check passed across ${checked} source and compiled files.`);
  if (tracked === null) console.log('Tracked-file check skipped: not a Git checkout.');
}
