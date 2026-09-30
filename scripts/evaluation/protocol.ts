import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { validateLocalModelOrigin } from '../../connector/local-model.js';

export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256').update(value).digest('hex');
export const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const gitHash = z.string().regex(/^[a-f0-9]{40}$/);
const label = z.string().trim().min(1).max(500);
const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const timestamp = z.string().datetime();
export const arms = ['S', 'P', 'B'] as const;
export type Arm = (typeof arms)[number];
export const registrationSchema = z
  .object({
    schema_version: z.literal(1),
    experiment_id: identifier,
    status: z.literal('approved'),
    mode: z.enum(['development', 'heldout']),
    created_at_utc: timestamp,
    app_sha: gitHash,
    evaluation_sha: gitHash,
    manifest_sha256: hash,
    executor_sha256: hash,
    runtime_hash: hash,
    weights_hash: hash,
    model_id: z.string().regex(/^[A-Za-z0-9._/-]{1,120}$/),
    endpoint: label,
    permitted_endpoints: z.array(label).length(1),
    generation: z
      .object({
        temperature: z.literal(0),
        max_tokens: z.number().int().min(64).max(384),
        timeout_ms: z.number().int().min(50).max(28000),
        concurrency: z.literal(1),
      })
      .strict(),
    templates: z.object({ research_sha256: hash, verify_sha256: hash }).strict(),
    machine: label,
    runtime_evidence: label,
    weights_evidence: label,
    warm_up: z.literal('none; model already loaded; no excluded inference'),
    ordering_seed: z.number().int().min(0).max(0xffffffff),
    case_ids: z.array(identifier).min(1).max(100),
    arms: z.tuple([z.literal('S'), z.literal('P'), z.literal('B')]),
    retry_policy: z.literal('one primary inference per stage; no retries'),
    protocol_review: z.object({ reviewer: label, approved_at_utc: timestamp }).strict(),
    reviewers: z.array(label).length(2),
    access_log: z
      .array(
        z
          .object({
            identity: label,
            heldout_access: z.boolean(),
            excluded_from_tuning: z.boolean(),
            attested_at_utc: timestamp,
          })
          .strict(),
      )
      .min(1),
    thresholds: z
      .object({
        structural_packages: z.literal(95),
        independently_acceptable_packages: z.literal(90),
        denominator: z.literal(100),
        comparison: z.literal('descriptive-only'),
      })
      .strict(),
    fixed_draft_variant: z.literal('claim-only'),
  })
  .strict();
export type Registration = z.infer<typeof registrationSchema>;
const caseSchema = z
  .object({
    id: identifier,
    source: z
      .string()
      .min(1)
      .max(4000)
      .refine((value) => value.trim().length > 0),
    adversarial_draft: z
      .object({
        claim: z
          .string()
          .min(1)
          .max(150)
          .refine((value) => value.trim().length > 0),
      })
      .passthrough(),
  })
  .passthrough();
export const corpusSchema = z
  .object({
    schema_version: z.literal(1),
    split: z.enum(['development', 'heldout']),
    cases: z.array(caseSchema).min(1).max(100),
  })
  .strict();
export type Corpus = z.infer<typeof corpusSchema>;
export const frozenFiles = [
  'README.md',
  'PROTOCOL.md',
  'validate.py',
  'test_validate.py',
  'corpus/development.json',
  'corpus/heldout.json',
];
const manifestSchema = z
  .object({
    schema_version: z.literal(1),
    status: z.literal('candidate-requires-review-before-inference'),
    files: z.array(
      z.object({ path: z.string(), bytes: z.number().int().min(1), sha256: hash }).strict(),
    ),
  })
  .strict();
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function childPath(root: string, name: string) {
  const path = resolve(root, name);
  const rel = relative(root, path);
  requireThat(
    rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel),
    'Path escapes artifact root.',
  );
  return path;
}
export async function externalDirectory(appRoot: string, directory: string) {
  const [app, dir] = await Promise.all([realpath(appRoot), realpath(directory)]);
  const rel = relative(app, dir);
  requireThat(
    rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel),
    'Evaluation material must be outside the application repository.',
  );
  return dir;
}
export async function readPackage(root: string, mode: Registration['mode']) {
  root = await realpath(root);
  const bytes = await readFile(resolve(root, 'manifest.json'));
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const paths = manifest.files.map((entry) => entry.path);
  requireThat(
    new Set(paths).size === paths.length &&
      paths.length === frozenFiles.length &&
      frozenFiles.every((path) => paths.includes(path)),
    'Frozen inventory mismatch.',
  );
  for (const entry of manifest.files) {
    // Development preparation never opens held-out bytes, including for hashing.
    if (mode === 'development' && entry.path === 'corpus/heldout.json') continue;
    const path = childPath(root, entry.path);
    requireThat((await realpath(path)) === path, 'Linked frozen file.');
    const content = await readFile(path);
    requireThat(
      content.length === entry.bytes && sha256(content) === entry.sha256,
      'Frozen file integrity mismatch.',
    );
  }
  const corpusBytes = await readFile(resolve(root, `corpus/${mode}.json`));
  const corpus = corpusSchema.parse(JSON.parse(corpusBytes.toString('utf8')));
  requireThat(corpus.split === mode, 'Corpus split mismatch.');
  const ids = corpus.cases.map((item) => item.id);
  requireThat(new Set(ids).size === ids.length, 'Duplicate case IDs.');
  requireThat(
    corpus.cases.every((item) => Buffer.byteLength(item.source) <= 6000),
    'Source exceeds byte limit.',
  );
  if (mode === 'heldout') {
    requireThat(
      ids.length === 100 &&
        Array.from({ length: 100 }, (_, i) => `HLD-${String(i + 1).padStart(3, '0')}`).every((id) =>
          ids.includes(id),
        ),
      'Held-out roster must contain the full frozen 100 cases.',
    );
  }
  return { manifest, manifestBytes: bytes, manifestHash: sha256(bytes), corpus, corpusBytes };
}
export function validateRegistration(
  value: unknown,
  evidence: {
    appSha: string;
    evaluationSha: string;
    manifestHash: string;
    executorHash: string;
    templates: Registration['templates'];
    corpus: Corpus;
  },
) {
  const registration = registrationSchema.parse(value);
  requireThat(
    Date.parse(registration.created_at_utc) <= Date.now(),
    'Registration is future-dated.',
  );
  requireThat(
    Date.parse(registration.protocol_review.approved_at_utc) <=
      Date.parse(registration.created_at_utc),
    'Protocol review must precede registration.',
  );
  requireThat(
    registration.app_sha === evidence.appSha &&
      registration.evaluation_sha === evidence.evaluationSha,
    'Commit provenance mismatch.',
  );
  requireThat(
    registration.manifest_sha256 === evidence.manifestHash &&
      registration.executor_sha256 === evidence.executorHash,
    'Frozen provenance mismatch.',
  );
  requireThat(
    registration.templates.research_sha256 === evidence.templates.research_sha256 &&
      registration.templates.verify_sha256 === evidence.templates.verify_sha256,
    'Prompt/schema provenance mismatch.',
  );
  validateLocalModelOrigin(registration.endpoint);
  requireThat(
    registration.permitted_endpoints[0] === registration.endpoint,
    'Endpoint is not preregistered.',
  );
  requireThat(
    registration.reviewers[0] !== registration.reviewers[1],
    'Two distinct reviewers required.',
  );
  requireThat(
    registration.access_log.every((entry) => !entry.heldout_access || entry.excluded_from_tuning),
    'Held-out access requires exclusion from tuning.',
  );
  const ids = evidence.corpus.cases.map((item) => item.id).sort();
  requireThat(
    registration.mode === evidence.corpus.split &&
      new Set(registration.case_ids).size === registration.case_ids.length &&
      JSON.stringify([...registration.case_ids].sort()) === JSON.stringify(ids),
    'Registered roster mismatch.',
  );
  return registration;
}
export function executionOrder(registration: Registration) {
  const ids = [...registration.case_ids].sort();
  let state = registration.ordering_seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
  }
  return ids.flatMap((caseId, index) =>
    (index % 2 === 0 ? ['S', 'P', 'B'] : ['P', 'S', 'B']).map((arm) => ({
      case_id: caseId,
      arm: arm as Arm,
    })),
  );
}
