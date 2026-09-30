import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { LocalModelError } from '../../connector/local-model.js';
import { ExecutorFailureError } from '../../connector/index.js';
import {
  evaluationJob,
  emptyObservation,
  type ObservedExecutor,
  type Observation,
} from './executor.js';
import {
  arms,
  childPath,
  executionOrder,
  json,
  requireThat,
  sha256,
  type Arm,
  type Corpus,
  type Registration,
  registrationSchema,
  corpusSchema,
} from './protocol.js';

export type StageStatus =
  | 'completed'
  | 'invalid_output'
  | 'timeout'
  | 'runtime_unavailable'
  | 'canceled'
  | 'input_rejected'
  | 'transport_failed';
type Artifact = { path: string; sha256: string };
type Row = {
  case_id: string;
  arm: Arm;
  attempt_id: string;
  primary: true;
  source_sha256: string;
  status: 'not_attempted';
  reason: string;
};
interface StageRecord {
  experiment_id: string;
  case_id: string;
  arm: Arm;
  attempt_id: string;
  stage: 'research' | 'verify';
  primary: true;
  inference_retried: false;
  start_monotonic_ms: number;
  end_monotonic_ms: number;
  elapsed_ms: number;
  status: StageStatus;
  safe_error_category: StageStatus | null;
  input: Artifact;
  output: Artifact | null;
  request: Artifact | null;
  raw: Artifact | null;
  observation: Omit<Observation, 'request' | 'raw'>;
  usage: Observation['usage'];
}
interface AttemptRecord {
  experiment_id: string;
  case_id: string;
  arm: Arm;
  attempt_id: string;
  primary: true;
  inference_retried: false;
  manifest_sha256: string;
  start_monotonic_ms: number;
  end_monotonic_ms: number;
  elapsed_ms: number;
  status: StageStatus;
  safe_error_category: StageStatus | null;
  stages: Artifact[];
  skipped_stages: { stage: 'verify'; reason: string }[];
  owner_actions: [];
  acceptance_origin: null;
  reviewer_scores: [null, null];
  adjudication: null;
}
async function immutable(root: string, path: string, value: unknown): Promise<Artifact> {
  const bytes = json(value);
  await writeFile(childPath(root, path), bytes, { flag: 'wx', mode: 0o600 });
  return { path, sha256: sha256(bytes) };
}
function statusFor(error: unknown, signal: AbortSignal): StageStatus {
  if (signal.aborted) return 'canceled';
  if (error instanceof LocalModelError) {
    return {
      configuration: 'input_rejected',
      input: 'input_rejected',
      transport: 'transport_failed',
      canceled: 'timeout',
      response: 'invalid_output',
    }[error.code] as StageStatus;
  }
  if (error instanceof ExecutorFailureError) {
    return {
      'invalid-input': 'input_rejected',
      'invalid-output': 'invalid_output',
      'execution-timeout': 'timeout',
      'runtime-unavailable': 'runtime_unavailable',
    }[error.reason] as StageStatus;
  }
  return 'transport_failed';
}
function validUsage(value: unknown): Observation['usage'] {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  if (
    !Number.isInteger(usage.inputTokens) ||
    Number(usage.inputTokens) < 0 ||
    !Number.isInteger(usage.outputTokens) ||
    Number(usage.outputTokens) < 0
  )
    return null;
  if (
    usage.totalTokens !== null &&
    usage.totalTokens !== Number(usage.inputTokens) + Number(usage.outputTokens)
  )
    return null;
  return {
    inputTokens: Number(usage.inputTokens),
    outputTokens: Number(usage.outputTokens),
    totalTokens: usage.totalTokens as number | null,
  };
}
export interface RunOptions {
  directory: string;
  registration: Registration;
  corpus: Corpus;
  manifest: unknown;
  templates: unknown;
  execute: ObservedExecutor;
  signal?: AbortSignal;
  dryRun?: boolean;
}
export async function runEvaluation(options: RunOptions) {
  const { directory, registration, corpus } = options;
  registrationSchema.parse(registration);
  corpusSchema.parse(corpus);
  requireThat(
    new Set(registration.case_ids).size === registration.case_ids.length &&
      registration.case_ids.length === corpus.cases.length &&
      registration.case_ids.every((id) => corpus.cases.some((item) => item.id === id)) &&
      registration.mode === corpus.split,
    'Registered corpus mismatch.',
  );
  if (registration.mode === 'heldout')
    requireThat(corpus.cases.length === 100, 'Held-out runs require 100 cases.');
  const signal = options.signal ?? new AbortController().signal;
  // An existing directory is never resumed or overwritten. A repeated run needs a
  // separately registered experiment ID/directory; primary rows cannot be replaced.
  await mkdir(directory, { mode: 0o700 });
  for (const name of ['attempts', 'stages', 'artifacts'])
    await mkdir(resolve(directory, name), { mode: 0o700 });
  const roster: Row[] = executionOrder(registration).map((row) => ({
    ...row,
    attempt_id: `${row.case_id}-${row.arm}-primary`,
    primary: true,
    source_sha256: sha256(corpus.cases.find((item) => item.id === row.case_id)!.source),
    status: 'not_attempted',
    reason: 'No retained attempt-start record.',
  }));
  const snapshots = {
    registration: await immutable(directory, 'registration.json', registration),
    manifest: await immutable(directory, 'manifest.json', options.manifest),
    corpus: await immutable(directory, 'corpus.json', corpus),
    templates: await immutable(directory, 'templates.json', options.templates),
    roster: await immutable(directory, 'roster.json', roster),
  };
  await immutable(directory, 'run.json', {
    schema_version: 1,
    snapshots,
    experiment_id: registration.experiment_id,
    started_at_utc: new Date().toISOString(),
    time_origin_ms: performance.timeOrigin,
    dry_run: !!options.dryRun,
    quality: 'unknown; independent review not implemented',
    model_runtime_hash_verification:
      'operator attestation; runtime and weight bytes not read by harness',
    owner_review: 'direct executor only; no application owner gates advanced',
  });
  for (const row of roster) {
    if (signal.aborted || options.dryRun) break;
    const item = corpus.cases.find((candidate) => candidate.id === row.case_id)!;
    const started = performance.now();
    const identity = {
      experiment_id: registration.experiment_id,
      case_id: row.case_id,
      arm: row.arm,
      attempt_id: row.attempt_id,
      primary: true as const,
      inference_retried: false as const,
    };
    await immutable(directory, `attempts/${row.attempt_id}.start.json`, {
      ...identity,
      start_monotonic_ms: started,
      manifest_sha256: registration.manifest_sha256,
    });
    const stages: Artifact[] = [];
    const skipped: AttemptRecord['skipped_stages'] = [];
    let status: StageStatus = 'completed';
    async function stage(capability: 'research' | 'verify', input: string) {
      const prefix = `${row.attempt_id}-${capability}`;
      const inputArtifact = await immutable(directory, `artifacts/${prefix}.input.json`, {
        capability,
        input,
      });
      const start = performance.now();
      await immutable(directory, `stages/${prefix}.start.json`, {
        ...identity,
        stage: capability,
        input: inputArtifact,
        start_monotonic_ms: start,
      });
      const observation = emptyObservation();
      let output: Record<string, unknown> | null = null;
      let stageStatus: StageStatus = 'completed';
      try {
        output = await options.execute(
          evaluationJob(input, capability, prefix),
          { signal },
          observation,
        );
        requireThat(
          output && typeof output === 'object' && !Array.isArray(output),
          'Executor returned no object.',
        );
      } catch (error) {
        stageStatus = statusFor(error, signal);
      }
      const end = performance.now();
      const outputArtifact = output
        ? await immutable(directory, `artifacts/${prefix}.output.json`, output)
        : null;
      const rawArtifact =
        observation.raw === null
          ? null
          : await immutable(directory, `artifacts/${prefix}.raw.json`, {
              text: observation.raw,
              complete: observation.raw_complete,
            });
      const requestArtifact =
        observation.request === null
          ? null
          : await immutable(directory, `artifacts/${prefix}.request.json`, observation.request);
      const { request: _request, raw: _raw, ...metadata } = observation;
      const record: StageRecord = {
        ...identity,
        stage: capability,
        start_monotonic_ms: start,
        end_monotonic_ms: end,
        elapsed_ms: end - start,
        status: stageStatus,
        safe_error_category: stageStatus === 'completed' ? null : stageStatus,
        input: inputArtifact,
        output: outputArtifact,
        raw: rawArtifact,
        request: requestArtifact,
        observation: metadata,
        usage: observation.usage ?? validUsage(output?.usage),
      };
      stages.push(await immutable(directory, `stages/${prefix}.json`, record));
      status = stageStatus;
      return output;
    }
    if (row.arm === 'B') {
      await stage(
        'verify',
        JSON.stringify({ source: item.source, draft: { claim: item.adversarial_draft.claim } }),
      );
    } else {
      const draft = await stage('research', item.source);
      if (row.arm === 'P') {
        if (status === 'completed' && draft)
          await stage('verify', JSON.stringify({ source: item.source, draft }));
        else
          skipped.push({ stage: 'verify', reason: 'Research stage failed; no draft fabricated.' });
      }
    }
    const ended = performance.now();
    const record: AttemptRecord = {
      ...identity,
      manifest_sha256: registration.manifest_sha256,
      start_monotonic_ms: started,
      end_monotonic_ms: ended,
      elapsed_ms: ended - started,
      status,
      safe_error_category: status === 'completed' ? null : status,
      stages,
      skipped_stages: skipped,
      owner_actions: [],
      acceptance_origin: null,
      reviewer_scores: [null, null],
      adjudication: null,
    };
    await immutable(directory, `attempts/${row.attempt_id}.json`, record);
  }
  await immutable(directory, 'stop.json', {
    reason: options.dryRun ? 'dry_run' : signal.aborted ? 'operator_canceled' : 'roster_exhausted',
    stopped_at_utc: new Date().toISOString(),
  });
  const report = await summarizeRun(directory);
  await immutable(directory, 'summary.json', report);
  return report;
}
async function readJson<T>(root: string, name: string): Promise<T> {
  return JSON.parse(await readFile(childPath(root, name), 'utf8')) as T;
}
async function readArtifact<T>(root: string, artifact: Artifact): Promise<T> {
  const bytes = await readFile(childPath(root, artifact.path));
  requireThat(sha256(bytes) === artifact.sha256, 'Retained artifact hash mismatch.');
  return JSON.parse(bytes.toString('utf8')) as T;
}
function validateTiming(
  record: { start_monotonic_ms: number; end_monotonic_ms: number; elapsed_ms: number },
  label: string,
) {
  requireThat(
    Number.isFinite(record.start_monotonic_ms) &&
      record.start_monotonic_ms >= 0 &&
      Number.isFinite(record.end_monotonic_ms) &&
      record.end_monotonic_ms >= record.start_monotonic_ms &&
      Number.isFinite(record.elapsed_ms) &&
      record.elapsed_ms >= 0 &&
      record.elapsed_ms === record.end_monotonic_ms - record.start_monotonic_ms,
    `${label} timing mismatch.`,
  );
}
function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    observed_count: sorted.length,
    median_ms: sorted.length
      ? (sorted[Math.floor((sorted.length - 1) / 2)]! +
          sorted[Math.ceil((sorted.length - 1) / 2)]!) /
        2
      : null,
    p95_ms: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
}
export async function summarizeRun(directory: string) {
  const run = await readJson<{ snapshots: Record<string, Artifact> }>(directory, 'run.json');
  const registration = registrationSchema.parse(
    await readArtifact(directory, run.snapshots.registration!),
  );
  const corpus = corpusSchema.parse(await readArtifact(directory, run.snapshots.corpus!));
  const roster = await readArtifact<Row[]>(directory, run.snapshots.roster!);
  await readArtifact(directory, run.snapshots.manifest!);
  await readArtifact(directory, run.snapshots.templates!);
  const expected = executionOrder(registration);
  requireThat(
    roster.length === expected.length &&
      new Set(roster.map((row) => `${row.case_id}/${row.arm}`)).size === expected.length,
    'Missing or duplicate roster members.',
  );
  for (let i = 0; i < roster.length; i++) {
    const row = roster[i]!;
    const item = corpus.cases.find((candidate) => candidate.id === row.case_id);
    requireThat(
      item &&
        row.case_id === expected[i]!.case_id &&
        row.arm === expected[i]!.arm &&
        row.source_sha256 === sha256(item.source) &&
        row.attempt_id === `${row.case_id}-${row.arm}-primary`,
      'Roster or source changed.',
    );
  }
  const names = await readdir(resolve(directory, 'attempts'));
  const attempts: AttemptRecord[] = [];
  const started = new Set<string>();
  const attemptStarts = new Map<string, AttemptRecord>();
  const completed = new Set<string>();
  for (const name of names) {
    requireThat(name.endsWith('.json'), 'Unknown attempt artifact.');
    const record = await readJson<AttemptRecord>(directory, `attempts/${name}`);
    const row = roster.find((candidate) => candidate.attempt_id === record.attempt_id);
    requireThat(
      row &&
        record.case_id === row.case_id &&
        record.arm === row.arm &&
        record.primary === true &&
        record.inference_retried === false &&
        record.experiment_id === registration.experiment_id &&
        record.manifest_sha256 === registration.manifest_sha256,
      'Unknown or mismatched primary attempt.',
    );
    if (name.endsWith('.start.json')) {
      requireThat(!started.has(record.attempt_id), 'Duplicate primary start.');
      requireThat(
        Number.isFinite(record.start_monotonic_ms) && record.start_monotonic_ms >= 0,
        'Attempt start timing mismatch.',
      );
      started.add(record.attempt_id);
      attemptStarts.set(record.attempt_id, record);
    } else {
      requireThat(!completed.has(record.attempt_id), 'Duplicate primary row.');
      validateTiming(record, 'Attempt');
      completed.add(record.attempt_id);
      attempts.push(record);
    }
  }
  const stageResults: { arm: Arm; record: StageRecord }[] = [];
  const stageNames = await readdir(resolve(directory, 'stages'));
  for (const name of stageNames) {
    requireThat(
      roster.some(
        (row) =>
          started.has(row.attempt_id) &&
          ['research', 'verify'].some(
            (stage) =>
              name === `${row.attempt_id}-${stage}.json` ||
              name === `${row.attempt_id}-${stage}.start.json`,
          ),
      ),
      'Unknown stage artifact.',
    );
  }
  const partialAttempts: AttemptRecord[] = [];
  for (const row of roster.filter(
    (candidate) => started.has(candidate.attempt_id) && !completed.has(candidate.attempt_id),
  )) {
    const refs: Artifact[] = [];
    for (const stage of ['research', 'verify']) {
      const name = `${row.attempt_id}-${stage}.json`;
      if (stageNames.includes(name))
        refs.push({
          path: `stages/${name}`,
          sha256: sha256(await readFile(childPath(directory, `stages/${name}`))),
        });
    }
    if (refs.length)
      partialAttempts.push({
        ...row,
        experiment_id: registration.experiment_id,
        stages: refs,
      } as unknown as AttemptRecord);
  }
  for (const attempt of [...attempts, ...partialAttempts]) {
    requireThat(started.has(attempt.attempt_id), 'Attempt missing start evidence.');
    const attemptStart = attemptStarts.get(attempt.attempt_id)!;
    if (completed.has(attempt.attempt_id))
      requireThat(
        attempt.start_monotonic_ms === attemptStart.start_monotonic_ms,
        'Attempt start timing mismatch.',
      );
    const item = corpus.cases.find((candidate) => candidate.id === attempt.case_id)!;
    let draft: Record<string, unknown> | null = null;
    const expectedStages =
      attempt.arm === 'B'
        ? ['verify']
        : attempt.arm === 'S'
          ? ['research']
          : ['research', 'verify'];
    requireThat(
      attempt.stages.length >= 1 && attempt.stages.length <= expectedStages.length,
      'Invalid stage count.',
    );
    let previous: StageRecord | undefined;
    for (const [index, ref] of attempt.stages.entries()) {
      const stage = await readArtifact<StageRecord>(directory, ref);
      requireThat(
        stage.attempt_id === attempt.attempt_id &&
          stage.experiment_id === registration.experiment_id &&
          stage.case_id === attempt.case_id &&
          stage.arm === attempt.arm &&
          stage.stage === expectedStages[index],
        'Stage identity/order mismatch.',
      );
      requireThat(
        !previous || previous.status === 'completed',
        'Checker ran after failed research.',
      );
      requireThat(
        [
          'completed',
          'invalid_output',
          'timeout',
          'runtime_unavailable',
          'canceled',
          'input_rejected',
          'transport_failed',
        ].includes(stage.status) &&
          stage.primary === true &&
          stage.inference_retried === false,
        'Invalid stage status or retry.',
      );
      requireThat(
        stageNames.includes(`${stage.attempt_id}-${stage.stage}.start.json`),
        'Stage missing start evidence.',
      );
      const input = await readArtifact<{ capability: string; input: string }>(
        directory,
        stage.input,
      );
      const expectedInput =
        stage.stage === 'research'
          ? item.source
          : JSON.stringify({
              source: item.source,
              draft: attempt.arm === 'B' ? { claim: item.adversarial_draft.claim } : draft,
            });
      requireThat(
        input.capability === stage.stage && input.input === expectedInput,
        'Changed model input.',
      );
      if (stage.output)
        draft = await readArtifact<Record<string, unknown>>(directory, stage.output);
      requireThat(
        stage.status !== 'completed' || stage.output !== null,
        'Completed stage has no output.',
      );
      if (stage.raw) await readArtifact(directory, stage.raw);
      if (stage.request) await readArtifact(directory, stage.request);
      validateTiming(stage, 'Stage');
      const stageStart = await readJson<StageRecord>(
        directory,
        `stages/${stage.attempt_id}-${stage.stage}.start.json`,
      );
      requireThat(
        stageStart.attempt_id === stage.attempt_id &&
          stageStart.case_id === stage.case_id &&
          stageStart.arm === stage.arm &&
          stageStart.experiment_id === stage.experiment_id &&
          stageStart.stage === stage.stage &&
          stageStart.start_monotonic_ms === stage.start_monotonic_ms &&
          stageStart.input.path === stage.input.path &&
          stageStart.input.sha256 === stage.input.sha256,
        'Stage start evidence mismatch.',
      );
      requireThat(
        stage.start_monotonic_ms >= attemptStart.start_monotonic_ms &&
          (!completed.has(attempt.attempt_id) ||
            stage.end_monotonic_ms <= attempt.end_monotonic_ms) &&
          (!previous || stage.start_monotonic_ms >= previous.end_monotonic_ms),
        'Stage timing escapes attempt or order.',
      );
      previous = stage;
      stageResults.push({ arm: attempt.arm, record: stage });
    }
    if (completed.has(attempt.attempt_id))
      requireThat(
        previous?.status === attempt.status &&
          (attempt.status !== 'completed' || attempt.stages.length === expectedStages.length),
        'Attempt completion mismatch.',
      );
  }
  const byArm = Object.fromEntries(
    arms.map((arm) => {
      const rows = roster.filter((row) => row.arm === arm);
      const records = attempts.filter((attempt) => attempt.arm === arm);
      const stages = stageResults.filter((stage) => stage.arm === arm).map((stage) => stage.record);
      const statuses = Object.fromEntries(
        [
          'completed',
          'invalid_output',
          'timeout',
          'runtime_unavailable',
          'canceled',
          'input_rejected',
          'transport_failed',
        ].map((status) => [status, records.filter((attempt) => attempt.status === status).length]),
      );
      return [
        arm,
        {
          denominator: registration.case_ids.length,
          attempted: rows.filter((row) => started.has(row.attempt_id)).length,
          completed: statuses.completed,
          graded: 0,
          not_attempted: rows.filter((row) => !started.has(row.attempt_id)).length,
          interrupted: rows.filter(
            (row) => started.has(row.attempt_id) && !completed.has(row.attempt_id),
          ).length,
          statuses,
          end_to_end_latency: latency(records.map((record) => record.elapsed_ms)),
          per_stage_latency: Object.fromEntries(
            ['research', 'verify'].map((stage) => [
              stage,
              latency(
                stages
                  .filter((record) => record.stage === stage)
                  .map((record) => record.elapsed_ms),
              ),
            ]),
          ),
          observed_request_count: stages.filter((stage) => stage.request !== null).length,
          stage_calls_started: stageNames.filter(
            (name) =>
              name.endsWith('.start.json') &&
              rows.some((row) => name.startsWith(`${row.attempt_id}-`)),
          ).length,
          unfinished_stage_count: stageNames.filter(
            (name) =>
              name.endsWith('.start.json') &&
              rows.some((row) => name.startsWith(`${row.attempt_id}-`)) &&
              !stageNames.includes(name.replace('.start.json', '.json')),
          ).length,
          available_usage: {
            stages_with_usage: stages.filter((stage) => stage.usage !== null).length,
            stages_missing_usage: stages.filter((stage) => stage.usage === null).length,
            stages_missing_total_tokens: stages.filter((stage) => stage.usage?.totalTokens == null)
              .length,
            total_tokens: stages.some((stage) => stage.usage?.totalTokens != null)
              ? stages.reduce((sum, stage) => sum + (stage.usage?.totalTokens ?? 0), 0)
              : null,
            input_tokens: stages.some((stage) => stage.usage)
              ? stages.reduce((sum, stage) => sum + (stage.usage?.inputTokens ?? 0), 0)
              : null,
            output_tokens: stages.some((stage) => stage.usage)
              ? stages.reduce((sum, stage) => sum + (stage.usage?.outputTokens ?? 0), 0)
              : null,
          },
        },
      ];
    }),
  );
  let stop: { reason: string } | null = null;
  try {
    stop = await readJson(directory, 'stop.json');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  requireThat(
    stop === null || ['dry_run', 'operator_canceled', 'roster_exhausted'].includes(stop.reason),
    'Unknown stop reason.',
  );
  const canceled =
    stop?.reason === 'operator_canceled' ||
    stageResults.some(({ record }) => record.status === 'canceled');
  const whollyUnavailable =
    stageResults.length > 0 &&
    stageResults.every(({ record }) =>
      ['runtime_unavailable', 'transport_failed'].includes(record.status),
    );
  const finished =
    stop?.reason === 'roster_exhausted' &&
    started.size === roster.length &&
    completed.size === roster.length &&
    !canceled &&
    !whollyUnavailable;
  return {
    experiment_id: registration.experiment_id,
    mode: registration.mode,
    execution: finished ? 'finished' : 'incomplete',
    execution_reason: canceled
      ? 'operator_canceled'
      : whollyUnavailable
        ? 'runtime_unavailable'
        : finished
          ? 'roster_exhausted'
          : stop?.reason === 'dry_run'
            ? 'dry_run'
            : 'unfinished_roster',
    quality: 'unknown; no independent scores recorded',
    gates: { E03: 'incomplete', E14: 'incomplete', E18: 'incomplete' },
    denominators: 'full registered roster per arm; no survivor-only denominator',
    arms: byArm,
    roster: roster.map((row) => {
      const attempt = attempts.find((candidate) => candidate.attempt_id === row.attempt_id);
      return {
        case_id: row.case_id,
        arm: row.arm,
        attempt_id: row.attempt_id,
        status: attempt?.status ?? (started.has(row.attempt_id) ? 'interrupted' : 'not_attempted'),
        reason: attempt
          ? attempt.safe_error_category
          : started.has(row.attempt_id)
            ? 'Started without terminal attempt record; retained stages still counted.'
            : 'No retained start; see stop.json when available.',
      };
    }),
    inference_compute_ms: null,
    human_review_minutes: null,
    peak_memory: null,
    cpu: null,
    limitations: [
      'Runtime/weights provenance is operator-attested.',
      'Raw response capture is bounded to 64 KiB; missing usage remains null.',
      'Completed means executor validation only, never quality acceptance.',
      'No reviewer ingestion, adjudication, confusion matrix, paired quality table or statistical test is implemented.',
    ],
  };
}
