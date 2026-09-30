import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runConnector } from './index.js';
import { validateHostedAppConfig } from './hosted-config.js';
import { createLocalModelExecutor, validateLocalModelOrigin } from './local-model.js';

/** Opt-in applies only to the app transport. Model inference remains numeric-loopback only. */
export function parseLocalModelConfig(config: unknown, configPath: string) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid configuration');
  const fields = config as Record<string, unknown>;
  const names = ['baseUrl', 'token', 'sequenceFile', 'modelEndpoint', 'model'];
  const optional = ['appMode', 'protectionBypassToken'];
  if (
    !names.every((name) => typeof fields[name] === 'string') ||
    Object.keys(fields).some((name) => ![...names, ...optional].includes(name)) ||
    (fields.appMode !== undefined && fields.appMode !== 'local' && fields.appMode !== 'hosted')
  )
    throw new Error('Invalid configuration');
  const baseUrl = fields.baseUrl as string;
  let hostedApp;
  if (fields.appMode === 'hosted') {
    hostedApp = validateHostedAppConfig(
      { origin: baseUrl, protectionBypassToken: fields.protectionBypassToken },
      baseUrl,
    );
  } else {
    if ('protectionBypassToken' in fields) throw new Error('Invalid configuration');
    validateLocalModelOrigin(baseUrl);
  }
  validateLocalModelOrigin(fields.modelEndpoint as string);
  return {
    baseUrl,
    token: fields.token as string,
    sequenceFile: resolve(dirname(configPath), fields.sequenceFile as string),
    hostedApp,
    modelEndpoint: fields.modelEndpoint as string,
    model: fields.model as string,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== 'connect') throw new Error('Usage');
  const configPath = resolve(args[1]!);
  const handle = await open(configPath, 'r');
  let raw: string;
  try {
    if ((await handle.stat()).size > 8 * 1024) throw new Error('Configuration too large');
    raw = await handle.readFile('utf8');
    if (Buffer.byteLength(raw, 'utf8') > 8 * 1024) throw new Error('Configuration too large');
  } finally {
    await handle.close();
  }
  const config = parseLocalModelConfig(JSON.parse(raw), configPath);
  const execute = createLocalModelExecutor({
    endpoint: config.modelEndpoint,
    model: config.model,
  });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await runConnector({
      baseUrl: config.baseUrl,
      token: config.token,
      hostedApp: config.hostedApp,
      sequenceFile: config.sequenceFile,
      execute,
      signal: abort.signal,
      onEvent: (event) => console.log(`[Central City local model] ${event.type}`),
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error(
      'Local model connector stopped. Check private configuration, app access, local runtime health, native token and sequence lock. See docs/LOCAL_MODEL.md.',
    );
    process.exitCode = 1;
  });
