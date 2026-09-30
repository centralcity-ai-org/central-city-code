#!/usr/bin/env node
// Checks first-load JS per route and the vendor chunk against scripts/bundle-budget/budgets.json.
// Exit 0: within budget. Exit 1: over budget or a configured chunk/root is missing.
// Exit 2: unusable input (manifest missing, invalid JSON or config, listed file missing).
import {
  EXIT,
  UnusableInput,
  evaluate,
  formatTable,
  readJson,
  resolvePaths,
  validateConfig,
  validateManifest,
} from './lib.mjs';

const usage = `Usage: node scripts/bundle-budget/check.mjs [--dist dist] [--manifest <path>] [--config <path>] [--json]
Reads <dist>/.vite/manifest.json (Vite build.manifest: true, or "vite build --manifest").`;

try {
  const paths = resolvePaths(process.argv.slice(2));
  if (paths.help) {
    console.log(usage);
    process.exit(EXIT.ok);
  }
  const config = validateConfig(readJson(paths.config, 'Budget config'));
  let manifestJson;
  try {
    manifestJson = readJson(paths.manifest, 'Vite manifest');
  } catch (error) {
    if (error instanceof UnusableInput)
      error.message +=
        '\nBuild with a manifest first: set build.manifest: true in vite.config.ts, or run "pnpm exec vite build --manifest".';
    throw error;
  }
  const manifest = validateManifest(manifestJson);
  const result = evaluate({ manifest, config, distDir: paths.dist });
  console.log(paths.json ? JSON.stringify(result, null, 2) : formatTable(result));
  process.exit(result.ok ? EXIT.ok : EXIT.overBudget);
} catch (error) {
  if (error instanceof UnusableInput) {
    console.error(`bundle-budget: ${error.message}`);
    process.exit(EXIT.unusable);
  }
  // Never let a crash read as a budget verdict (exit 1).
  console.error('bundle-budget: internal error');
  console.error(error);
  process.exit(EXIT.unusable);
}
