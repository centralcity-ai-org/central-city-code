import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync, constants } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/bundle-budget/check.mjs');
const shippedConfig = path.resolve('scripts/bundle-budget/budgets.json');

type Chunk = {
  file: string;
  name?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
};
type Result = {
  ok: boolean;
  unitBytes: number;
  rows: Array<{
    kind: 'route' | 'vendor';
    name: string;
    budgetBytes: number;
    gzipBytes: number;
    rawBytes: number;
    cssGzipBytes: number;
    files: string[];
    missing: string[];
    status: 'PASS' | 'FAIL' | 'MISSING';
  }>;
};

/** Deterministic, poorly compressible bytes so gzip sizes are predictable in scale. */
function noise(bytes: number, seed: number): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0 || 1;
  for (let index = 0; index < bytes; index++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[index] = x & 0xff;
  }
  return out;
}
const gz = (buffer: Buffer) => gzipSync(buffer, { level: constants.Z_BEST_COMPRESSION }).length;

function fixture(
  t: { after: (callback: () => void) => void },
  files: Record<string, Buffer | string>,
  manifest: Record<string, Chunk> | string | null,
  config?: unknown,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'central-city-budget-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dist = path.join(directory, 'dist');
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    fs.writeFileSync(path.join(dist, file), content);
  }
  if (manifest !== null) {
    fs.mkdirSync(path.join(dist, '.vite'), { recursive: true });
    fs.writeFileSync(
      path.join(dist, '.vite', 'manifest.json'),
      typeof manifest === 'string' ? manifest : JSON.stringify(manifest),
    );
  }
  const configPath = path.join(directory, 'budgets.json');
  if (config !== undefined)
    fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config));
  const run = (...extra: string[]) => {
    const args = [script, '--dist', dist];
    if (config !== undefined) args.push('--config', configPath);
    const result = spawnSync(process.execPath, [...args, ...extra], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return { run, dist };
}

const kb = 1000;
const config = (overrides: Record<string, unknown> = {}) => ({
  unitBytes: 1000,
  vendor: { chunkName: 'vendor', maxKB: 70 },
  routes: [
    { route: '/', roots: ['index.html', 'src/Landing.tsx'], maxKB: 90 },
    { route: '/rooms/:id', roots: ['index.html', 'src/Room.tsx'], maxKB: 125 },
  ],
  ...overrides,
});

// A split build: entry + vendor, lazy landing/room/app chunks.
const vendor = noise(60 * kb, 1);
const entry = noise(8 * kb, 2);
const landing = noise(5 * kb, 3);
const room = noise(15 * kb, 4);
const app = noise(20 * kb, 5);
const preview = noise(30 * kb, 6);
const files = {
  'assets/vendor-a.js': vendor,
  'assets/index-b.js': entry,
  'assets/landing-c.js': landing,
  'assets/room-d.js': room,
  'assets/app-e.js': app,
  'assets/preview-f.js': preview,
  'assets/index-g.css': noise(4 * kb, 7),
};
const manifest: Record<string, Chunk> = {
  'index.html': {
    file: 'assets/index-b.js',
    name: 'index',
    isEntry: true,
    imports: ['_vendor-a.js'],
    dynamicImports: ['src/Landing.tsx', 'src/Room.tsx'],
    css: ['assets/index-g.css'],
  },
  '_vendor-a.js': { file: 'assets/vendor-a.js', name: 'vendor' },
  'src/Landing.tsx': {
    file: 'assets/landing-c.js',
    isDynamicEntry: true,
    imports: ['_vendor-a.js', 'index.html'],
    dynamicImports: ['src/Preview.tsx'],
  },
  'src/Preview.tsx': { file: 'assets/preview-f.js', isDynamicEntry: true },
  'src/Room.tsx': {
    file: 'assets/room-d.js',
    isDynamicEntry: true,
    imports: ['_app-e.js', '_vendor-a.js'],
  },
  '_app-e.js': { file: 'assets/app-e.js', imports: ['_vendor-a.js'] },
};

function json(out: { stdout: string }): Result {
  return JSON.parse(out.stdout) as Result;
}

test('passes a split build and counts each shared chunk once per route', (t) => {
  const { run } = fixture(t, files, manifest, config());
  const out = run('--json');
  assert.equal(out.status, 0, out.stderr);
  const result = json(out);
  assert.equal(result.ok, true);
  const home = result.rows.find((row) => row.name === '/')!;
  assert.deepEqual(home.files, ['assets/index-b.js', 'assets/landing-c.js', 'assets/vendor-a.js']);
  assert.equal(home.gzipBytes, gz(entry) + gz(landing) + gz(vendor));
  const roomRow = result.rows.find((row) => row.name === '/rooms/:id')!;
  assert.equal(roomRow.gzipBytes, gz(entry) + gz(room) + gz(app) + gz(vendor));
  const vendorRow = result.rows.find((row) => row.kind === 'vendor')!;
  assert.equal(vendorRow.status, 'PASS');
  assert.equal(vendorRow.gzipBytes, gz(vendor));
});

test('excludes dynamic imports (the lazy preview) from first-load JS', (t) => {
  const { run } = fixture(t, files, manifest, config());
  const home = json(run('--json')).rows.find((row) => row.name === '/')!;
  assert.ok(!home.files.includes('assets/preview-f.js'));
});

test('measures gzip at level 9 on the built bytes', (t) => {
  const { run } = fixture(t, files, manifest, config());
  const vendorRow = json(run('--json')).rows.find((row) => row.kind === 'vendor')!;
  assert.equal(vendorRow.rawBytes, vendor.length);
  assert.equal(vendorRow.gzipBytes, gzipSync(vendor, { level: 9 }).length);
});

test('route overrun exits 1 and names the route and overage in the table', (t) => {
  const tight = config({
    routes: [{ route: '/', roots: ['index.html', 'src/Landing.tsx'], maxKB: 10 }],
  });
  const out = fixture(t, files, manifest, tight).run();
  assert.equal(out.status, 1);
  assert.match(out.stdout, /route \/\s+10\.00\s+\d+\.\d\d\s+\d+\.\d\d\s+\d+\.\d\d\s+FAIL/);
  assert.match(
    out.stdout,
    /FAIL: route \/ is \d+\.\d\d KB gzip, \d+\.\d\d KB over its 10\.00 KB budget\./,
  );
  assert.match(out.stdout, /OVER BUDGET/);
});

test('vendor overrun exits 1 even when every route passes', (t) => {
  const out = fixture(
    t,
    files,
    manifest,
    config({ vendor: { chunkName: 'vendor', maxKB: 1 } }),
  ).run('--json');
  assert.equal(out.status, 1);
  const result = json(out);
  assert.equal(result.rows.find((row) => row.kind === 'vendor')!.status, 'FAIL');
  assert.ok(
    result.rows.filter((row) => row.kind === 'route').every((row) => row.status === 'PASS'),
  );
});

test('a missing vendor chunk or route root is a budget failure (exit 1), not a silent pass', (t) => {
  const unsplit: Record<string, Chunk> = {
    'index.html': { file: 'assets/index-b.js', isEntry: true },
  };
  const out = fixture(t, { 'assets/index-b.js': entry }, unsplit, config()).run();
  assert.equal(out.status, 1);
  assert.match(out.stdout, /MISSING: no JS chunk named "vendor"/);
  assert.match(out.stdout, /MISSING: route \/ root\(s\) not in the manifest: src\/Landing\.tsx/);
});

test('missing manifest exits 2 with build instructions', (t) => {
  const out = fixture(t, files, null, config()).run();
  assert.equal(out.status, 2);
  assert.match(out.stderr, /Vite manifest not found/);
  assert.match(out.stderr, /build\.manifest: true|vite build --manifest/);
  assert.equal(out.stdout, '');
});

test('unreadable manifest, invalid config, unknown flag and missing built file exit 2', (t) => {
  assert.equal(fixture(t, files, '{not json', config()).run().status, 2);
  assert.equal(fixture(t, files, {}, config()).run().status, 2);
  const badConfig = fixture(t, files, manifest, {
    routes: [{ route: '/', roots: [], maxKB: -1 }],
  }).run();
  assert.equal(badConfig.status, 2);
  assert.match(badConfig.stderr, /Invalid budget config: .*roots.*maxKB/);
  assert.equal(fixture(t, files, manifest, config()).run('--bogus').status, 2);
  const withoutVendorFile = { ...files } as Record<string, Buffer>;
  delete withoutVendorFile['assets/vendor-a.js'];
  const missingFile = fixture(t, withoutVendorFile, manifest, config()).run();
  assert.equal(missingFile.status, 2);
  assert.match(missingFile.stderr, /Built file listed in the manifest is missing/);
});

test('import cycles terminate', (t) => {
  const cyclic: Record<string, Chunk> = {
    'index.html': { file: 'assets/index-b.js', isEntry: true, imports: ['_a.js'] },
    '_a.js': { file: 'assets/landing-c.js', imports: ['_b.js'] },
    '_b.js': { file: 'assets/room-d.js', imports: ['_a.js', 'index.html'] },
  };
  const out = fixture(t, files, cyclic, {
    routes: [{ route: '/', roots: ['index.html'], maxKB: 500 }],
  }).run('--json');
  assert.equal(out.status, 0, out.stderr);
  assert.equal(json(out).rows[0]!.files.length, 3);
});

test('the shipped config holds the DESIGN_SYSTEM E4 budgets', () => {
  const shipped = JSON.parse(fs.readFileSync(shippedConfig, 'utf8')) as ReturnType<typeof config>;
  assert.equal(shipped.unitBytes, 1000);
  assert.equal(shipped.vendor.chunkName, 'vendor');
  assert.equal(shipped.vendor.maxKB, 70);
  const byRoute = Object.fromEntries(shipped.routes.map((route) => [route.route, route.maxKB]));
  assert.deepEqual(byRoute, {
    '/': 90,
    '/rooms/:id': 125,
    // ROOM_WORKSPACES §1.1: the lazy Markdown and highlighting chunks, as totals with what they
    // load with (the highlighting chunk itself stays under the spec's 35 kB gzip).
    'room Markdown (lazy; total incl. vendor)': 105,
    'room code highlighting (lazy; total incl. vendor and Markdown)': 130,
  });
});
