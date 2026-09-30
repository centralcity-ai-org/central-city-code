import { execFileSync } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executorHash, executorTemplates, observedLocalExecutor } from './evaluation/executor.js';
import {
  externalDirectory,
  json,
  readPackage,
  registrationSchema,
  requireThat,
  validateRegistration,
} from './evaluation/protocol.js';
import { runEvaluation, summarizeRun } from './evaluation/runner.js';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function argumentsMap(argv: string[]) {
  const result = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    requireThat(key.startsWith('--') && !result.has(key), 'Unknown or duplicate argument.');
    if (key === '--execute') result.set(key, 'true');
    else {
      const value = argv[++i];
      requireThat(value && !value.startsWith('--'), 'Missing argument value.');
      result.set(key, value);
    }
  }
  return result;
}
const args = argumentsMap(process.argv.slice(3));
function required(key: string) {
  const value = args.get(key);
  requireThat(value, `Required option: ${key}`);
  return value;
}
const git = (root: string, values: string[]) =>
  execFileSync('git', ['-C', root, ...values], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
async function main() {
  const command = process.argv[2];
  if (command === 'fingerprint') {
    const options = {
      endpoint: required('--endpoint'),
      model: required('--model'),
      maxTokens: Number(args.get('--max-tokens') ?? 320),
      timeoutMs: Number(args.get('--timeout-ms') ?? 28000),
    };
    console.log(
      json({ executor_sha256: await executorHash(appRoot), ...(await executorTemplates(options)) }),
    );
    return;
  }
  if (command === 'report') {
    const directory = await externalDirectory(appRoot, required('--run'));
    console.log(json(await summarizeRun(directory)));
    return;
  }
  requireThat(command === 'run', 'Use fingerprint, run, or report. See docs/MODEL_EVALUATION.md.');
  const registrationPath = await realpath(required('--registration'));
  await externalDirectory(appRoot, dirname(registrationPath));
  const registrationBytes = await readFile(registrationPath);
  const registration = registrationSchema.parse(JSON.parse(registrationBytes.toString('utf8')));
  const evaluationRoot = await externalDirectory(appRoot, required('--evaluation'));
  const output = resolve(required('--out'));
  await externalDirectory(appRoot, dirname(output));
  const options = {
    endpoint: registration.endpoint,
    model: registration.model_id,
    maxTokens: registration.generation.max_tokens,
    timeoutMs: registration.generation.timeout_ms,
  };
  const templates = await executorTemplates(options); // intercepted requests, never network
  const prepared = await readPackage(evaluationRoot, registration.mode);
  validateRegistration(registration, {
    appSha: git(appRoot, ['rev-parse', 'HEAD']),
    evaluationSha: git(evaluationRoot, ['rev-parse', 'HEAD']),
    manifestHash: prepared.manifestHash,
    executorHash: await executorHash(appRoot),
    templates: templates.hashes,
    corpus: prepared.corpus,
  });
  // Frozen tracked bytes must match the registered commits. Untracked output is
  // outside the app; this does not use Git as an isolation or security boundary.
  git(appRoot, ['diff', '--exit-code', 'HEAD', '--']);
  git(evaluationRoot, ['diff', '--exit-code', 'HEAD', '--', evaluationRoot]);
  if (registration.mode === 'heldout' && args.has('--execute')) {
    // Full package validator immediately precedes scored execution. Its stdout
    // stays private; fail closed on any preparation/hash/corpus validation error.
    const result = JSON.parse(
      execFileSync('python3', [resolve(evaluationRoot, 'validate.py')], {
        cwd: evaluationRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30000,
      }),
    );
    requireThat(
      result.valid === true && result.manifest_verified === true,
      'Frozen package validation failed.',
    );
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    console.log(
      json(
        await runEvaluation({
          directory: output,
          registration,
          corpus: prepared.corpus,
          manifest: prepared.manifest,
          templates: templates.serialized,
          execute: observedLocalExecutor(options),
          signal: controller.signal,
          dryRun: !args.has('--execute'),
        }),
      ),
    );
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}
main().catch(() => {
  // Do not print private corpus, registration, raw response or arbitrary errors.
  console.error(
    'Evaluation stopped: invalid preparation, provenance, artifact, or local execution. Retain any partial run directory; see docs/MODEL_EVALUATION.md.',
  );
  process.exitCode = 1;
});
