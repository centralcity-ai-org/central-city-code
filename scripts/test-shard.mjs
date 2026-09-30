#!/usr/bin/env node
/*
 * Splits the Node test files (tests/*.test.ts) into CI shards and runs one of them.
 *
 *   node scripts/test-shard.mjs 2/4        run shard 2 of 4 (pnpm test:files <its files>)
 *   node scripts/test-shard.mjs --list 2/4 print shard 2's files, one per line
 *
 * Every file lands in exactly one shard (tests/ci-workflow.test.ts checks this for the shard
 * count the workflow uses). Files are assigned greedily, longest first, by the measured
 * seconds in WEIGHTS; a file missing from WEIGHTS counts as DEFAULT_WEIGHT, so a new test
 * file is always run, only perhaps in a less balanced shard. Refresh WEIGHTS when shards
 * drift apart (docs/CI.md, "Parallel jobs").
 *
 * No dependencies: the `changes` job imports this file before anything is installed.
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** The shard count the `unit` job's matrix uses. */
export const UNIT_SHARDS = 4;

/** Seconds per file, measured one file at a time locally (macOS arm64, 28 Sep 2026, total 1045 s). */
export const WEIGHTS = {
  'tests/a2a-mapping.test.ts': 3,
  'tests/a2a-transport.test.ts': 33,
  'tests/ai-guest-smoke.test.ts': 20,
  'tests/ai-workspaces.test.ts': 25,
  'tests/assistant-access.test.ts': 26,
  'tests/autonomous-creation.test.ts': 53,
  'tests/backend.test.ts': 47,
  'tests/bundle-budget.test.ts': 2,
  'tests/canary.test.ts': 5,
  'tests/connection-doctor.test.ts': 2,
  'tests/connector-failure.test.ts': 2,
  'tests/connector-process.test.ts': 8,
  'tests/connector.test.ts': 2,
  'tests/count-log-service.test.ts': 13,
  'tests/count-log.test.ts': 1,
  'tests/credential-rotation.test.ts': 27,
  'tests/cross-owner-pool.test.ts': 6,
  'tests/cross-owner.test.ts': 31,
  'tests/data-lock.test.ts': 1,
  'tests/distribution.test.ts': 7,
  'tests/guards.test.ts': 1,
  'tests/hosted-connector.test.ts': 1,
  'tests/hosted-database.test.ts': 1,
  'tests/hosted-handler.test.ts': 2,
  'tests/hosted-staging.test.ts': 21,
  'tests/invite-flow.test.ts': 23,
  'tests/join-links.test.ts': 11,
  'tests/load-guard.test.ts': 2,
  'tests/local-model.test.ts': 2,
  'tests/manifest.test.ts': 1,
  'tests/mcp-bridge.test.ts': 10,
  'tests/mcp-guide.test.ts': 10,
  'tests/mcp-join-clarity.test.ts': 15,
  'tests/mcp-open-invite.test.ts': 53,
  'tests/mcp-validation.test.ts': 17,
  'tests/member-status.test.ts': 27,
  'tests/message-threads.test.ts': 30,
  'tests/messaging-pool.test.ts': 1,
  'tests/messaging.test.ts': 31,
  'tests/migrations.test.ts': 26,
  'tests/model-evaluation.test.ts': 2,
  'tests/neon-load.test.ts': 2,
  'tests/oauth-hardening.test.ts': 35,
  'tests/oauth-rolling-grants.test.ts': 13,
  'tests/oauth.test.ts': 35,
  'tests/open-invite-bearer.test.ts': 9,
  'tests/pair-remediation-migration.test.ts': 10,
  'tests/presence.test.ts': 12,
  'tests/protocol-schemas.test.ts': 5,
  'tests/public-stats.test.ts': 11,
  'tests/quickstart.test.ts': 4,
  'tests/rate-limit.test.ts': 23,
  'tests/recovery.test.ts': 9,
  'tests/remediate-pair-contexts.test.ts': 6,
  'tests/remote-mcp.test.ts': 8,
  'tests/responder-crypto.test.ts': 1,
  'tests/responder-routes.test.ts': 9,
  'tests/responder-settings.test.ts': 22,
  'tests/responder-ui.test.ts': 1,
  'tests/results.test.ts': 88,
  'tests/room-format-migration.test.ts': 8,
  'tests/room-history.test.ts': 8,
  'tests/room-markdown.test.ts': 12,
  'tests/rooms-security.test.ts': 42,
  'tests/rooms.test.ts': 27,
  'tests/routes.test.ts': 4,
  'tests/secret-scan.test.ts': 1,
  'tests/sessions.test.ts': 20,
  'tests/ui-errors.test.ts': 1,
  'tests/unclaimed-ttl.test.ts': 13,
  'tests/validation-errors.test.ts': 4,
  'tests/wake.test.ts': 49,
  'tests/workflows.test.ts': 30,
  'tests/workspace-export.test.ts': 4,
};
export const DEFAULT_WEIGHT = 10;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function testFiles(dir = join(root, 'tests')) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => `tests/${name}`);
}

/** Longest-processing-time-first assignment; ties break by name, so the split is stable. */
export function assignShards(files, count, weights = WEIGHTS) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`Bad shard count: ${count}`);
  const weight = (file) => weights[file] ?? DEFAULT_WEIGHT;
  const ordered = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: count }, () => ({ files: [], seconds: 0 }));
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best));
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

function parse(spec) {
  const match = /^(\d+)\/(\d+)$/.exec(spec ?? '');
  if (!match) throw new Error('Usage: node scripts/test-shard.mjs [--list] <index>/<count>');
  const [index, count] = [Number(match[1]), Number(match[2])];
  if (index < 1 || index > count) throw new Error(`Shard ${index} is outside 1..${count}`);
  return { index, count };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const list = args[0] === '--list';
  const { index, count } = parse(list ? args[1] : args[0]);
  const shard = assignShards(testFiles(), count)[index - 1];
  if (list) {
    console.log(shard.files.join('\n'));
  } else {
    console.log(
      `Shard ${index}/${count}: ${shard.files.length} files, about ${Math.round(shard.seconds)} s measured`,
    );
    if (shard.files.length === 0) process.exit(0);
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const result = spawnSync(pnpm, ['test:files', ...shard.files], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    process.exit(result.status ?? 1);
  }
}
