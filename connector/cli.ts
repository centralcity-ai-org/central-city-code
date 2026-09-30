import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { runConnector } from './index.js';
import { deterministicExecutor } from './demo-executor.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== 'connect') {
    console.error('Usage: npm run connector -- connect <private-config.json>');
    process.exitCode = 1;
    return;
  }
  const configPath = resolve(args[1]!);
  const handle = await open(configPath, 'r');
  let raw: string;
  try {
    if ((await handle.stat()).size > 8 * 1024) throw new Error('Configuration is too large.');
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid configuration.');
  const config = parsed as Record<string, unknown>;
  if (
    typeof config.baseUrl !== 'string' ||
    typeof config.token !== 'string' ||
    typeof config.sequenceFile !== 'string'
  ) {
    throw new Error('Configuration requires baseUrl, token, sequenceFile.');
  }
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runConnector({
      baseUrl: config.baseUrl,
      token: config.token,
      sequenceFile: resolve(dirname(configPath), config.sequenceFile),
      execute: deterministicExecutor,
      signal: abort.signal,
      onEvent: (event) =>
        console.log(`[Central City] ${event.type}${event.jobId ? ` job=${event.jobId}` : ''}`),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

main().catch(() => {
  // Never echo configuration, arbitrary server errors, tokens, inputs, or stack traces.
  console.error(
    'Connector stopped with an error. Check server availability, token status, configuration, and sequence lock. See docs/CONNECTOR.md.',
  );
  process.exitCode = 1;
});
