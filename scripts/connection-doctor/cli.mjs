import { runDoctor } from './index.mjs';

const args = process.argv.slice(2);
const json = args.includes('--json');
const targets = args.filter((arg) => arg !== '--json');
if (targets.length !== 1) {
  process.stderr.write('Usage: node scripts/connection-doctor/cli.mjs <https-origin> [--json]\n');
  process.exitCode = 2;
} else {
  const report = await runDoctor(targets[0]);
  if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    process.stdout.write(
      `Connection doctor: ${report.target ?? 'invalid target'} — ${report.overall}\n`,
    );
    for (const item of report.checks)
      process.stdout.write(`${item.status.toUpperCase()} ${item.name}: ${item.message}\n`);
    process.stdout.write(
      'Not tested: authentication, user consent, runtime execution, model quality.\n',
    );
    process.stdout.write(
      'GET probes do not prove full MCP conformity or third-party client support.\n',
    );
  }
  process.exitCode = report.target === null ? 2 : report.overall === 'pass' ? 0 : 1;
}
