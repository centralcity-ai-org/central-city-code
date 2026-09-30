import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ScenarioResult } from './scenarios/ops.js';
import type { Probe } from './scenarios/s5-probes.js';

export interface ProfileReport {
  limits: 'on' | 'off';
  seed: {
    owners: number;
    agentsPerOwner: number;
    hostedPerOwner: number;
    seconds: number;
    errors: number;
  };
  scenarios: ScenarioResult[];
  probes: Probe[];
  /** Host 1-minute load average when the profile started and ended (other work skews results). */
  hostLoad: { start: number; end: number };
  /** Set when the profile aborted (e.g. the server child died); results are partial. */
  incomplete?: string;
}
export interface RunReport {
  runId: string;
  startedAt: string;
  finishedAt: string;
  target: 'local';
  appSha: string;
  appDirty: boolean;
  node: string;
  machine: {
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    cpus: number;
    memoryGb: number;
  };
  options: Record<string, string>;
  profiles: ProfileReport[];
  /** True when any profile aborted; later profiles were not run. */
  incomplete?: boolean;
}

/** Keys whose values must never reach a report, whatever produced them. */
const SECRET_KEYS = /token|cookie|secret|password|authorization|signature|nonce|idempotency/i;
export function redact<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, val) =>
      key && SECRET_KEYS.test(key) && typeof val === 'string' ? '[redacted]' : val,
    ),
  );
}

const fmt = (value: unknown): string =>
  typeof value === 'number'
    ? Number.isInteger(value)
      ? String(value)
      : value < 0.01 && value > 0
        ? value.toExponential(1)
        : value.toFixed(2)
    : Array.isArray(value)
      ? value.join(',')
      : String(value);

function table(columns: string[], rows: Array<Array<unknown>>): string {
  return [
    `| ${columns.join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(fmt).join(' | ')} |`),
  ].join('\n');
}

export function markdown(report: RunReport): string {
  const lines: string[] = [];
  lines.push(`# Central City load baseline ${report.runId}`, '');
  if (report.incomplete)
    lines.push('**INCOMPLETE RUN** — a profile aborted; results below are partial.', '');
  lines.push(
    `- App: \`${report.appSha.slice(0, 12)}\`${report.appDirty ? ' (working tree dirty)' : ''}; target: local (hosted mode, in-process PGlite)`,
    `- Node ${report.node}; ${report.machine.cpu} × ${report.machine.cpus}, ${report.machine.memoryGb} GB, ${report.machine.platform} ${report.machine.release} ${report.machine.arch}`,
    `- Started ${report.startedAt}, finished ${report.finishedAt}`,
    `- Options: ${
      Object.entries(report.options)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ') || 'defaults'
    }`,
    '',
  );
  for (const profile of report.profiles) {
    lines.push(`## Limits ${profile.limits}`, '');
    if (profile.incomplete) lines.push(`**Aborted:** ${profile.incomplete}`, '');
    lines.push(
      `Seed: ${profile.seed.owners} owners × ${profile.seed.agentsPerOwner} agents (${profile.seed.hostedPerOwner} hosted) in ${profile.seed.seconds}s, ${profile.seed.errors} errors. Host load average (1 min): ${profile.hostLoad.start} at start, ${profile.hostLoad.end} at end on ${report.machine.cpus} CPUs.`,
      '',
    );
    if (Math.max(profile.hostLoad.start, profile.hostLoad.end) > report.machine.cpus / 2)
      lines.push(
        '> The host was busy with other work during this profile; treat latencies as noisy and compare only against runs under similar load.',
        '',
      );
    lines.push(
      table(
        [
          'scenario',
          'rps',
          'requests',
          'errors',
          'refused (429/capacity)',
          'lock hold p95 ms',
          'tx wait p95 ms',
          'blob p95 KiB',
          'event loop p99 ms',
          'server CPU %',
        ],
        profile.scenarios.map((s) => [
          `${s.id} ${s.title}`,
          s.requests.totals.rps,
          s.requests.totals.requests,
          s.requests.totals.errors,
          s.requests.totals.refused,
          s.server.db.lockHoldMs.p95,
          s.server.db.transactionWaitMs.p95,
          Math.round(s.server.db.blobBytes.p95 / 102.4) / 10,
          s.server.eventLoopDelayMs.p99,
          s.server.cpuPercent,
        ]),
      ),
      '',
    );
    if (profile.probes.length)
      lines.push(
        '### Probes',
        '',
        table(
          ['probe', 'result', 'detail'],
          profile.probes.map((p) => [p.name, p.pass ? 'PASS' : 'FAIL', p.detail]),
        ),
        '',
      );
    for (const scenario of profile.scenarios) {
      lines.push(`### ${scenario.id} ${scenario.title}`, '');
      lines.push(
        Object.entries(scenario.metrics)
          .map(
            ([key, value]) =>
              `${key}: **${fmt(typeof value === 'number' && key.endsWith('Rate') ? Number((value * 100).toFixed(3)) : value)}${key.endsWith('Rate') ? '%' : ''}**`,
          )
          .join(' · '),
        '',
      );
      for (const extra of scenario.tables ?? [])
        if (extra.title !== 'Probes')
          lines.push(`${extra.title}:`, '', table(extra.columns, extra.rows), '');
      lines.push(
        table(
          ['route', 'count', 'rps', 'p50', 'p95', 'p99', 'max', 'statuses', 'err', 'refused'],
          scenario.requests.routes.map((r) => [
            r.route,
            r.count,
            r.rps,
            r.p50,
            r.p95,
            r.p99,
            r.max,
            Object.entries(r.statuses)
              .map(([s, c]) => `${s}:${c}`)
              .join(' '),
            r.errors,
            r.refused,
          ]),
        ),
        '',
      );
      const errors = scenario.requests.routes.flatMap((r) =>
        r.errorSamples.map((e) => `${r.route}: ${e}`),
      );
      if (errors.length) lines.push('Error samples:', '', ...errors.map((e) => `- ${e}`), '');
      const db = scenario.server.db;
      lines.push(
        `DB: ${db.transactions} transactions (${db.workspaceLockTransactions} took the workspace lock), ${db.queriesTotal} queries; lock acquire p95 ${db.lockAcquireMs.p95} ms, lock hold p50/p95/p99/max ${db.lockHoldMs.p50}/${db.lockHoldMs.p95}/${db.lockHoldMs.p99}/${db.lockHoldMs.max} ms; tx wait p95/max ${db.transactionWaitMs.p95}/${db.transactionWaitMs.max} ms; ${db.blobWrites} blob writes, p50/p95/max ${db.blobBytes.p50}/${db.blobBytes.p95}/${db.blobBytes.max} B. Event loop delay p50/p99/max ${scenario.server.eventLoopDelayMs.p50}/${scenario.server.eventLoopDelayMs.p99}/${scenario.server.eventLoopDelayMs.max} ms; server CPU ${scenario.server.cpuPercent}% of one core; RSS ${scenario.server.memory.rssMb} MB.`,
        '',
        'Top SQL shapes by total time:',
        '',
        table(
          ['sql', 'count', 'total ms', 'mean ms', 'max ms'],
          db.queryShapes
            .slice(0, 8)
            .map((q) => [
              `\`${q.sql.replace(/\|/g, '\\|')}\``,
              q.count,
              q.totalMs,
              q.meanMs,
              q.maxMs,
            ]),
        ),
        '',
      );
      for (const note of scenario.notes ?? []) lines.push(`> ${note}`);
      if (scenario.notes?.length) lines.push('');
    }
  }
  return lines.join('\n');
}

export async function writeReport(
  dir: string,
  report: RunReport,
): Promise<{ json: string; md: string }> {
  await mkdir(dir, { recursive: true });
  const safe = redact(report);
  const json = join(dir, 'report.json');
  const md = join(dir, 'summary.md');
  await writeFile(json, `${JSON.stringify(safe, null, 2)}\n`);
  await writeFile(md, `${markdown(safe)}\n`);
  return { json, md };
}
