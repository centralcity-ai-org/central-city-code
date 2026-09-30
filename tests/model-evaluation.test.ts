import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  copyFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ExecutorFailureError, type Executor } from '../connector/index.js';
import {
  executorTemplates,
  injectedExecutor,
  observedLocalExecutor,
  evaluationJob,
  emptyObservation,
} from '../scripts/evaluation/executor.js';
import {
  executionOrder,
  frozenFiles,
  json,
  readPackage,
  sha256,
  validateRegistration,
  type Corpus,
  type Registration,
} from '../scripts/evaluation/protocol.js';
import { runEvaluation, summarizeRun } from '../scripts/evaluation/runner.js';

const h = 'a'.repeat(64);
const corpus: Corpus = {
  schema_version: 1,
  split: 'development',
  cases: [1, 2].map((n) => ({
    id: `DEV-${String(n).padStart(3, '0')}`,
    source: `Fictional note ${n}: three boxes arrived.`,
    category: 'synthetic',
    required_facts: ['NEVER_SEND_GOLD'],
    adversarial_draft: {
      claim: `Claim ${n}`,
      expected_assessment: 'NEVER_SEND_LABEL',
      supporting_quote: 'NEVER_SEND_QUOTE',
      reason: 'NEVER_SEND_REASON',
    },
  })),
};
function registration(): Registration {
  return {
    schema_version: 1,
    experiment_id: 'synthetic-test',
    status: 'approved',
    mode: 'development',
    created_at_utc: '2025-01-02T00:00:00.000Z',
    app_sha: 'a'.repeat(40),
    evaluation_sha: 'b'.repeat(40),
    manifest_sha256: h,
    executor_sha256: h,
    runtime_hash: h,
    weights_hash: h,
    model_id: 'synthetic-model',
    endpoint: 'http://127.0.0.1:4322',
    permitted_endpoints: ['http://127.0.0.1:4322'],
    generation: { temperature: 0, max_tokens: 320, timeout_ms: 28000, concurrency: 1 },
    templates: { research_sha256: h, verify_sha256: h },
    machine: 'Synthetic test machine',
    runtime_evidence: 'Synthetic fixture; no runtime',
    weights_evidence: 'Synthetic fixture; no weights',
    warm_up: 'none; model already loaded; no excluded inference',
    ordering_seed: 7,
    case_ids: corpus.cases.map((item) => item.id),
    arms: ['S', 'P', 'B'],
    retry_policy: 'one primary inference per stage; no retries',
    protocol_review: { reviewer: 'Fixture reviewer', approved_at_utc: '2025-01-01T00:00:00.000Z' },
    reviewers: ['Reviewer A', 'Reviewer B'],
    access_log: [
      {
        identity: 'Fixture',
        heldout_access: false,
        excluded_from_tuning: false,
        attested_at_utc: '2025-01-01T00:00:00.000Z',
      },
    ],
    thresholds: {
      structural_packages: 95,
      independently_acceptable_packages: 90,
      denominator: 100,
      comparison: 'descriptive-only',
    },
    fixed_draft_variant: 'claim-only',
  };
}
async function workspace(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(resolve(tmpdir(), 'central-city-evaluation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const success: Executor = async (job) => ({ value: `synthetic-${job.id}`, usage: null });
async function run(root: string, execute: Executor = success, extra = {}) {
  return runEvaluation({
    directory: resolve(root, 'run'),
    registration: registration(),
    corpus,
    manifest: { fixture: true },
    templates: { fixture: true },
    execute: injectedExecutor(execute),
    ...extra,
  });
}
const read = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

test('S/P retain independent research calls; B receives only source and fixed claim; full denominators', async (t) => {
  const root = await workspace(t);
  const inputs: { input: string; capability: string }[] = [];
  const report = await run(root, async (job, context) => {
    inputs.push(job);
    return success(job, context);
  });
  assert.equal(inputs.length, 8);
  for (const item of corpus.cases) {
    assert.equal(inputs.filter((input) => input.input === item.source).length, 2);
    assert.equal(
      inputs.filter(
        (input) =>
          input.input ===
          JSON.stringify({ source: item.source, draft: { claim: item.adversarial_draft.claim } }),
      ).length,
      1,
    );
  }
  assert.ok(inputs.every((input) => !input.input.includes('NEVER_SEND')));
  assert.deepEqual(
    ['S', 'P', 'B'].map((arm) => report.arms[arm].denominator),
    [2, 2, 2],
  );
  assert.equal(report.arms.P.completed, 2);
  assert.equal(report.arms.P.graded, 0);
  assert.equal(report.arms.P.available_usage.input_tokens, null);
  assert.equal(report.gates.E14, 'incomplete');
  await assert.rejects(run(root), /EEXIST/);
});

test('failure and partial usage remain in P; failed research skips checker without inference retry', async (t) => {
  const root = await workspace(t);
  let failedResearchCalls = 0;
  const report = await run(root, async (job) => {
    if (job.id === 'DEV-001-P-primary-research') {
      failedResearchCalls++;
      throw new ExecutorFailureError('invalid-output');
    }
    if (job.id === 'DEV-002-P-primary-verify') throw new ExecutorFailureError('execution-timeout');
    return { synthetic: true, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  });
  assert.equal(failedResearchCalls, 1);
  assert.equal(report.arms.P.denominator, 2);
  assert.equal(report.arms.P.completed, 0);
  assert.equal(report.arms.P.statuses.invalid_output, 1);
  assert.equal(report.arms.P.statuses.timeout, 1);
  assert.equal(report.arms.P.available_usage.input_tokens, 10);
  assert.equal(report.arms.P.available_usage.stages_missing_usage, 2);
  const record = await read(resolve(root, 'run/attempts/DEV-001-P-primary.json'));
  assert.equal(record.stages.length, 1);
  assert.equal(record.skipped_stages.length, 1);
});

test('dry-run and pre-cancellation preserve every unattempted row and call no executor', async (t) => {
  for (const dryRun of [true, false]) {
    const root = await workspace(t);
    const controller = new AbortController();
    controller.abort();
    const report = await run(
      root,
      async () => {
        throw new Error('Must not execute');
      },
      { dryRun, signal: controller.signal },
    );
    assert.equal(report.execution, 'incomplete');
    assert.equal(report.arms.S.attempted, 0);
    assert.equal(report.arms.S.not_attempted, 2);
    assert.equal(report.arms.S.denominator, 2);
    assert.match(report.quality, /unknown/);
  }
});

test('report rejects duplicate primary rows and unknown arms', async (t) => {
  const root = await workspace(t);
  await run(root);
  const dir = resolve(root, 'run/attempts');
  const file = resolve(dir, 'DEV-001-S-primary.json');
  await copyFile(file, resolve(dir, 'duplicate.json'));
  await assert.rejects(summarizeRun(resolve(root, 'run')), /Duplicate primary row/);
  await unlink(resolve(dir, 'duplicate.json'));
  const row = await read(file);
  row.arm = 'UNKNOWN';
  await writeFile(file, json(row));
  await assert.rejects(summarizeRun(resolve(root, 'run')), /Unknown or mismatched/);
});

test('report rejects missing roster members and altered manifests or inputs', async (t) => {
  for (const file of [
    'roster.json',
    'manifest.json',
    'artifacts/DEV-001-S-primary-research.input.json',
  ]) {
    const root = await workspace(t);
    await run(root);
    const target = resolve(root, 'run', file);
    const value = await read(target);
    if (Array.isArray(value)) value.pop();
    else value.tampered = true;
    await writeFile(target, json(value));
    await assert.rejects(summarizeRun(resolve(root, 'run')), /hash mismatch/);
  }
});

test('report ignores hand-entered totals and recovers retained stages after interrupted attempt', async (t) => {
  const root = await workspace(t);
  await run(root, async () => ({
    synthetic: true,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  }));
  await writeFile(resolve(root, 'run/summary.json'), json({ denominator: 1, quality: 'passed' }));
  await unlink(resolve(root, 'run/attempts/DEV-001-P-primary.json'));
  const report = await summarizeRun(resolve(root, 'run'));
  assert.equal(report.arms.P.denominator, 2);
  assert.equal(report.arms.P.interrupted, 1);
  assert.equal(report.arms.P.available_usage.input_tokens, 40);
  assert.match(report.quality, /unknown/);
});

test('registration fails closed on missing provenance, drift, endpoints and contamination', () => {
  const value = registration();
  const evidence = {
    appSha: value.app_sha,
    evaluationSha: value.evaluation_sha,
    manifestHash: h,
    executorHash: h,
    templates: value.templates,
    corpus,
  };
  assert.deepEqual(validateRegistration(value, evidence), value);
  for (const changed of [
    { ...value, runtime_hash: undefined },
    { ...value, manifest_sha256: 'c'.repeat(64) },
    { ...value, templates: { ...value.templates, verify_sha256: 'c'.repeat(64) } },
    { ...value, endpoint: 'https://example.com:443' },
    { ...value, case_ids: ['DEV-001'] },
    { ...value, access_log: [{ ...value.access_log[0], heldout_access: true }] },
  ])
    assert.throws(() => validateRegistration(changed, evidence));
  const heldout = {
    ...value,
    mode: 'heldout' as const,
    case_ids: Array.from({ length: 100 }, (_, n) => `HLD-${n + 1}`),
  };
  const ordered = executionOrder(heldout);
  assert.equal(ordered.filter((row, index) => row.arm === 'S' && index % 3 === 0).length, 50);
  assert.deepEqual(executionOrder(value), executionOrder(value));
});

test('development package validation never opens held-out file and catches drift', async (t) => {
  const root = await workspace(t);
  await mkdir(resolve(root, 'corpus'));
  const entries = [];
  for (const path of frozenFiles) {
    const bytes = path === 'corpus/development.json' ? json(corpus) : 'synthetic fixture';
    // Deliberately absent: this would fail if development mode opened heldout.
    if (path !== 'corpus/heldout.json') await writeFile(resolve(root, path), bytes);
    entries.push({ path, bytes: Buffer.byteLength(bytes), sha256: sha256(bytes) });
  }
  await writeFile(
    resolve(root, 'manifest.json'),
    json({
      schema_version: 1,
      status: 'candidate-requires-review-before-inference',
      files: entries,
    }),
  );
  const prepared = await readPackage(root, 'development');
  assert.equal(prepared.corpus.cases.length, 2);
  await assert.rejects(readPackage(root, 'heldout'), /ENOENT/);
  await writeFile(resolve(root, 'PROTOCOL.md'), 'changed');
  await assert.rejects(readPackage(root, 'development'), /integrity mismatch/);
});

test('frozen template capture makes no network calls; observed truncation preserves available usage', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  const options = { endpoint: 'http://127.0.0.1:4322', model: 'synthetic-model' };
  globalThis.fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        model: 'synthetic-model',
        choices: [
          { finish_reason: 'length', message: { role: 'assistant', content: '{unfinished' } },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
      }),
      { headers: { 'content-type': 'application/json' } },
    );
  };
  try {
    const templates = await executorTemplates(options);
    assert.equal(calls, 0);
    assert.match(templates.hashes.research_sha256, /^[a-f0-9]{64}$/);
    const observation = emptyObservation();
    await assert.rejects(
      observedLocalExecutor(options)(
        evaluationJob('Synthetic source.', 'research', 'test'),
        { signal: new AbortController().signal },
        observation,
      ),
    );
    assert.equal(calls, 1);
    assert.equal(observation.truncated, true);
    assert.equal(observation.raw_complete, true);
    assert.equal(observation.usage?.inputTokens, 12);
    assert.ok(observation.raw?.includes('unfinished'));
  } finally {
    globalThis.fetch = original;
  }
});

test('wholly unavailable execution and cancellation during final B remain incomplete', async (t) => {
  const unavailableRoot = await workspace(t);
  const unavailable = await run(unavailableRoot, async () => {
    throw new ExecutorFailureError('runtime-unavailable');
  });
  assert.equal(unavailable.execution, 'incomplete');
  assert.equal(unavailable.execution_reason, 'runtime_unavailable');
  for (const arm of ['S', 'P', 'B']) {
    assert.equal(unavailable.arms[arm].denominator, 2);
    assert.equal(unavailable.arms[arm].attempted, 2);
    assert.equal(unavailable.arms[arm].statuses.runtime_unavailable, 2);
  }
  const canceledRoot = await workspace(t);
  const controller = new AbortController();
  const final = executionOrder(registration()).at(-1)!;
  const canceled = await run(
    canceledRoot,
    async (job, context) => {
      if (job.id === `${final.case_id}-B-primary-verify`) {
        controller.abort();
        throw new Error('Synthetic final-stage cancellation');
      }
      return success(job, context);
    },
    { signal: controller.signal },
  );
  assert.equal(canceled.execution, 'incomplete');
  assert.equal(canceled.execution_reason, 'operator_canceled');
  assert.equal(canceled.roster.length, 6);
  assert.equal(canceled.arms.B.attempted, 2);
  assert.equal(canceled.arms.B.statuses.canceled, 1);
});

test('report rejects invalid attempt timing, changed starts and escaped stage intervals', async (t) => {
  const mutations = [
    (record: any) => {
      record.elapsed_ms = -999;
    },
    (record: any) => {
      record.elapsed_ms = null;
    },
    (record: any) => {
      record.start_monotonic_ms = -1;
    },
    (record: any) => {
      record.end_monotonic_ms = null;
    },
    (record: any) => {
      record.elapsed_ms += 1;
    },
    (record: any) => {
      record.start_monotonic_ms += 0.01;
      record.elapsed_ms = record.end_monotonic_ms - record.start_monotonic_ms;
    },
    (record: any) => {
      record.end_monotonic_ms = record.start_monotonic_ms;
      record.elapsed_ms = 0;
    },
  ];
  for (const mutate of mutations) {
    const root = await workspace(t);
    await run(root);
    const path = resolve(root, 'run/attempts/DEV-001-S-primary.json');
    const record = await read(path);
    mutate(record);
    await writeFile(path, json(record));
    await assert.rejects(summarizeRun(resolve(root, 'run')), /timing/);
  }
  const root = await workspace(t);
  await run(root);
  const startPath = resolve(root, 'run/stages/DEV-001-S-primary-research.start.json');
  const start = await read(startPath);
  start.start_monotonic_ms += 1;
  await writeFile(startPath, json(start));
  await assert.rejects(summarizeRun(resolve(root, 'run')), /Stage start evidence mismatch/);
});
