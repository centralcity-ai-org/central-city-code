// Bundle budget checker (docs/BUNDLE_BUDGET.md). No dependencies: node:fs, node:path, node:zlib.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { gzipSync, constants } from 'node:zlib';

export const EXIT = { ok: 0, overBudget: 1, unusable: 2 };

/** An input problem (missing manifest, invalid JSON or config): exit 2, never a budget verdict. */
export class UnusableInput extends Error {}

export function gzipSize(buffer) {
  return gzipSync(buffer, { level: constants.Z_BEST_COMPRESSION }).length;
}

export function readJson(path, what) {
  if (!existsSync(path)) throw new UnusableInput(`${what} not found: ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UnusableInput(`${what} is not valid JSON: ${path} (${error.message})`);
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

export function validateConfig(config) {
  const problems = [];
  if (!isRecord(config)) problems.push('config must be an object');
  else {
    if (config.unitBytes !== undefined && config.unitBytes !== 1000 && config.unitBytes !== 1024)
      problems.push('unitBytes must be 1000 or 1024');
    if (config.vendor !== undefined) {
      if (!isRecord(config.vendor)) problems.push('vendor must be an object');
      else {
        if (typeof config.vendor.chunkName !== 'string' || !config.vendor.chunkName)
          problems.push('vendor.chunkName must be a non-empty string');
        if (!positive(config.vendor.maxKB)) problems.push('vendor.maxKB must be a positive number');
      }
    }
    if (!Array.isArray(config.routes) || config.routes.length === 0)
      problems.push('routes must be a non-empty array');
    else
      config.routes.forEach((route, index) => {
        const at = `routes[${index}]`;
        if (!isRecord(route)) return problems.push(`${at} must be an object`);
        if (typeof route.route !== 'string' || !route.route)
          problems.push(`${at}.route must be a non-empty string`);
        if (
          !Array.isArray(route.roots) ||
          route.roots.length === 0 ||
          route.roots.some((root) => typeof root !== 'string' || !root)
        )
          problems.push(`${at}.roots must be a non-empty array of manifest keys`);
        if (!positive(route.maxKB)) problems.push(`${at}.maxKB must be a positive number`);
      });
  }
  if (problems.length) throw new UnusableInput(`Invalid budget config: ${problems.join('; ')}`);
  return { unitBytes: 1000, ...config };
}

export function validateManifest(manifest) {
  if (!isRecord(manifest) || Object.keys(manifest).length === 0)
    throw new UnusableInput('Manifest must be a non-empty object (Vite build.manifest output).');
  for (const [key, chunk] of Object.entries(manifest))
    if (!isRecord(chunk) || typeof chunk.file !== 'string')
      throw new UnusableInput(`Manifest entry "${key}" has no "file".`);
  return manifest;
}

/**
 * First-load closure of a route: its root keys plus everything reachable through static
 * `imports` (dynamic imports load later and are excluded). Shared chunks count once.
 */
export function staticClosure(manifest, roots) {
  const seen = new Set();
  const missing = [];
  const stack = [...roots];
  while (stack.length) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    const chunk = manifest[key];
    if (!chunk) {
      missing.push(key);
      continue;
    }
    seen.add(key);
    for (const next of chunk.imports ?? []) if (!seen.has(next)) stack.push(next);
  }
  return { keys: [...seen], missing: [...new Set(missing)] };
}

function fileSizer(distDir) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) {
      const path = join(distDir, file);
      if (!existsSync(path))
        throw new UnusableInput(`Built file listed in the manifest is missing: ${path}`);
      const buffer = readFileSync(path);
      cache.set(file, { raw: buffer.length, gzip: gzipSize(buffer) });
    }
    return cache.get(file);
  };
}

const isJs = (file) => /\.(m?js)$/i.test(file);

export function evaluate({ manifest, config, distDir }) {
  const size = fileSizer(distDir);
  const unit = config.unitBytes ?? 1000;
  const rows = [];

  for (const route of config.routes) {
    const { keys, missing } = staticClosure(manifest, route.roots);
    const js = [...new Set(keys.map((key) => manifest[key].file).filter(isJs))].sort();
    const css = [...new Set(keys.flatMap((key) => manifest[key].css ?? []))].sort();
    const gzip = js.reduce((sum, file) => sum + size(file).gzip, 0);
    const raw = js.reduce((sum, file) => sum + size(file).raw, 0);
    const cssGzip = css.reduce((sum, file) => sum + size(file).gzip, 0);
    const status = missing.length ? 'MISSING' : gzip <= route.maxKB * unit ? 'PASS' : 'FAIL';
    rows.push({
      kind: 'route',
      name: route.route,
      budgetBytes: route.maxKB * unit,
      gzipBytes: gzip,
      rawBytes: raw,
      cssGzipBytes: cssGzip,
      files: js,
      missing,
      status,
    });
  }

  if (config.vendor) {
    const matches = Object.values(manifest).filter(
      (chunk) => chunk.name === config.vendor.chunkName && isJs(chunk.file),
    );
    const files = [...new Set(matches.map((chunk) => chunk.file))].sort();
    const gzip = files.reduce((sum, file) => sum + size(file).gzip, 0);
    const raw = files.reduce((sum, file) => sum + size(file).raw, 0);
    rows.push({
      kind: 'vendor',
      name: `chunk "${config.vendor.chunkName}"`,
      budgetBytes: config.vendor.maxKB * unit,
      gzipBytes: gzip,
      rawBytes: raw,
      cssGzipBytes: 0,
      files,
      missing: files.length ? [] : [config.vendor.chunkName],
      status: files.length === 0 ? 'MISSING' : gzip <= config.vendor.maxKB * unit ? 'PASS' : 'FAIL',
    });
  }

  const ok = rows.every((row) => row.status === 'PASS');
  return { ok, unitBytes: unit, rows };
}

export function formatTable(result) {
  const unit = result.unitBytes;
  const kb = (bytes) => (bytes / unit).toFixed(2);
  const header = ['Check', 'Budget KB', 'JS gzip KB', 'JS raw KB', 'CSS gzip KB', 'Status'];
  const body = result.rows.map((row) => [
    row.kind === 'vendor' ? `vendor ${row.name}` : `route ${row.name}`,
    kb(row.budgetBytes),
    row.status === 'MISSING' && row.kind === 'vendor' ? '-' : kb(row.gzipBytes),
    row.status === 'MISSING' && row.kind === 'vendor' ? '-' : kb(row.rawBytes),
    row.kind === 'vendor' ? '-' : kb(row.cssGzipBytes),
    row.status,
  ]);
  const widths = header.map((title, index) =>
    Math.max(title.length, ...body.map((line) => line[index].length)),
  );
  const line = (cells) =>
    cells
      .map((cell, index) =>
        index === 0 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]),
      )
      .join('  ');
  const out = [
    line(header),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...body.map(line),
  ];
  out.push('');
  for (const row of result.rows) {
    if (row.missing.length)
      out.push(
        row.kind === 'vendor'
          ? `MISSING: no JS chunk named "${row.missing[0]}" in the manifest (advancedChunks group not configured?).`
          : `MISSING: route ${row.name} root(s) not in the manifest: ${row.missing.join(', ')}`,
      );
    if (row.status === 'FAIL')
      out.push(
        `FAIL: ${row.kind} ${row.name} is ${kb(row.gzipBytes)} KB gzip, ${kb(row.gzipBytes - row.budgetBytes)} KB over its ${kb(row.budgetBytes)} KB budget.`,
      );
  }
  for (const row of result.rows)
    if (row.kind === 'route') out.push(`${row.name}: ${row.files.join(', ') || '(no JS)'}`);
  out.push('');
  out.push(
    `${result.ok ? 'OK' : 'OVER BUDGET'}: gzip level 9, 1 KB = ${unit} bytes, first-load JS through static imports only.`,
  );
  return out.join('\n');
}

export function resolvePaths(argv, cwd = process.cwd()) {
  const options = { dist: 'dist', manifest: undefined, config: undefined, json: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new UnusableInput(`${arg} needs a value.`);
      return next;
    };
    if (arg === '--dist') options.dist = value();
    else if (arg === '--manifest') options.manifest = value();
    else if (arg === '--config') options.config = value();
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new UnusableInput(`Unknown argument: ${arg}`);
  }
  const dist = resolve(cwd, options.dist);
  return {
    dist,
    manifest: resolve(cwd, options.manifest ?? join(options.dist, '.vite', 'manifest.json')),
    config: resolve(cwd, options.config ?? join('scripts', 'bundle-budget', 'budgets.json')),
    json: options.json,
    help: Boolean(options.help),
  };
}
