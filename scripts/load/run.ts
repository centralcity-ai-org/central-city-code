/**
 * Phase-0 load harness orchestrator.
 *
 *   pnpm load:local [--limits=off|on|both] [--owners=10] [--agents=20] [--hosted=4]
 *                   [--scenarios=S5,S1,S2,S3,S4] [--s1-seconds=40] [--s2-levels=1,2,4,8,16,32]
 *                   [--s2-seconds=6] [--s3-jobs=420] [--s3-pairs=16] [--s3-output-bytes=2048] [--s4-creates=120]
 *
 * Output: .local/load/<runId>/report.json and summary.md (gitignored). See scripts/load/README.md.
 */
import { fork, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpus, totalmem, platform, release, arch, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LoadClient, Recorder } from './client.js';
import { parseTarget, preflight, GuardError } from './guard.js';
import { writeReport, type ProfileReport, type RunReport } from './report.js';
import { IpPool, seed } from './seed.js';
import { connectServer } from './server-handle.js';
import type { Context, ScenarioResult, ServerHandle } from './scenarios/ops.js';
import { runS1 } from './scenarios/s1-steady.js';
import { runS2 } from './scenarios/s2-hot-owner.js';
import { runS3 } from './scenarios/s3-blob.js';
import { runS4 } from './scenarios/s4-anonymous.js';
import { runS5, type Probe } from './scenarios/s5-probes.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');

function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of argv) {
    if (arg === '--') continue;
    const match = /^--([a-z0-9-]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new GuardError(`Unknown argument: ${arg}`);
    flags[match[1]!] = match[2] ?? 'true';
  }
  return flags;
}

/** The server child never inherits database, hosted or limit configuration from this shell. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(CITY_|DATABASE_URL|VERCEL|LOAD_|PG|POSTGRES|NEON)/i.test(key)) env[key] = value;
  return env;
}

async function startServer(limits: 'on' | 'off'): Promise<ServerHandle> {
  const child = fork(join(here, 'server.ts'), [`--limits=${limits}`], {
    cwd: root,
    env: childEnv(),
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    return await connectServer(child);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    throw error;
  }
}

function count(flags: Record<string, string>, key: string, fallback: number, min: number): number {
  const value = flags[key] === undefined ? fallback : Number(flags[key]);
  if (!Number.isSafeInteger(value) || value < min)
    throw new GuardError(`--${key} must be an integer of at least ${min}.`);
  return value;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function runProfile(
  limits: 'on' | 'off',
  runId: string,
  flags: Record<string, string>,
  log: (message: string) => void,
): Promise<ProfileReport> {
  const owners = count(flags, 'owners', 10, 1);
  const agentsPerOwner = count(flags, 'agents', 20, 2);
  const hostedPerOwner = count(flags, 'hosted', 4, 0);
  if (agentsPerOwner - hostedPerOwner < 2)
    throw new GuardError('--agents must leave at least two external agents after --hosted.');
  log(`— limits ${limits}: starting server`);
  const loadStart = Math.round(loadavg()[0]! * 100) / 100;
  const scenarios: ScenarioResult[] = [];
  let probes: Probe[] = [];
  const seedRecorder = new Recorder();
  let seedSeconds = 0;
  let incomplete: string | undefined;
  let server: ServerHandle | undefined;
  let client: LoadClient | undefined;
  try {
    server = await startServer(limits);
    client = new LoadClient(server.port);
    const ips = new IpPool(1);
    const ctx: Context = {
      client,
      ips,
      runId: `${runId}-${limits}`,
      limits,
      server,
      options: flags,
      log,
    };
    client.recorder = seedRecorder;
    const seedStart = Date.now();
    log(`seeding ${owners} owners × ${agentsPerOwner} agents`);
    const worlds = await seed(client, ips, {
      runId: ctx.runId,
      owners,
      agentsPerOwner,
      hostedPerOwner,
    });
    client.recorder = null;
    seedSeconds = (Date.now() - seedStart) / 1000;
    const selected = (flags.scenarios ?? 'S5,S1,S2,S3,S4').toUpperCase().split(',');
    for (const id of selected) {
      if (id === 'S5') {
        const result = await runS5(ctx, worlds[0]!);
        probes = result.probes;
        scenarios.push(result);
      } else if (id === 'S1') scenarios.push(await runS1(ctx, worlds));
      else if (id === 'S2') scenarios.push(await runS2(ctx));
      else if (id === 'S3') scenarios.push(await runS3(ctx));
      else if (id === 'S4') scenarios.push(await runS4(ctx));
      else throw new GuardError(`Unknown scenario ${id}.`);
      const last = scenarios[scenarios.length - 1]!;
      log(
        `  ${last.id}: ${last.requests.totals.requests} requests, ${last.requests.totals.rps} rps, ${last.requests.totals.errors} errors, ${last.requests.totals.refused} refused`,
      );
    }
  } catch (error) {
    if (error instanceof GuardError) throw error;
    // Fail fast but keep what was measured: the report is written and marked incomplete.
    incomplete = error instanceof Error ? error.message : 'Profile failed.';
    log(`profile aborted: ${incomplete}`);
  } finally {
    client?.close();
    await server?.stop();
  }
  return {
    limits,
    seed: {
      owners,
      agentsPerOwner,
      hostedPerOwner,
      seconds: Math.round(seedSeconds * 10) / 10,
      errors: seedRecorder.summary().totals.errors,
    },
    scenarios,
    probes,
    hostLoad: { start: loadStart, end: Math.round(loadavg()[0]! * 100) / 100 },
    ...(incomplete ? { incomplete } : {}),
  };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const target = parseTarget(flags.target);
  preflight(target, process.env, flags);
  if (target === 'neon')
    throw new GuardError(
      'Guards passed, but --target=neon execution is not yet supported in phase 0. Use --target=local.',
    );
  const limitsFlag = flags.limits ?? 'both';
  if (!['on', 'off', 'both'].includes(limitsFlag))
    throw new GuardError('--limits must be on, off or both.');
  const profiles = limitsFlag === 'both' ? (['off', 'on'] as const) : [limitsFlag as 'on' | 'off'];
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const runId = `${stamp.slice(2, 13)}-${randomBytes(2).toString('hex')}`;
  const log = (message: string) => console.log(`[load ${runId}] ${message}`);
  const startedAt = new Date().toISOString();
  const results: ProfileReport[] = [];
  for (const limits of profiles) {
    const profile = await runProfile(limits, runId, flags, log);
    results.push(profile);
    if (profile.incomplete) break;
  }
  const incomplete = results.some((profile) => profile.incomplete);
  const { target: _target, ...options } = flags;
  const report: RunReport = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: 'local',
    appSha: git(['rev-parse', 'HEAD']),
    appDirty: git(['status', '--porcelain', '--', 'server', 'shared', 'protocol']) !== '',
    node: process.version,
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpus: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
    },
    options,
    profiles: results,
    ...(incomplete ? { incomplete: true } : {}),
  };
  const files = await writeReport(join(root, '.local', 'load', runId), report);
  log(`report: ${files.md}`);
  const errors = results
    .flatMap((p) => p.scenarios)
    .reduce((sum, s) => sum + s.requests.totals.errors, 0);
  const failed = results.flatMap((p) => p.probes).filter((p) => !p.pass);
  if (failed.length) {
    log(`probe failures: ${failed.map((p) => p.name).join(', ')}`);
    process.exitCode = 1;
  }
  if (incomplete) {
    log('run INCOMPLETE: a profile aborted; the report holds partial results.');
    process.exitCode = 1;
  }
  log(`done: ${errors} non-intentional errors`);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof GuardError
      ? `Refused: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Load run failed.',
  );
  process.exitCode = 1;
});
