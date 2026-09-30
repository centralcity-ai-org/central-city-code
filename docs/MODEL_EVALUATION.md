# Local model evaluation runner

This is neutral execution and evidence collection tooling. It imports the existing
`connector/local-model.ts` executor, keeps its prompts and validation unchanged,
and never grades model quality. A mechanically completed call is not a quality
pass. Independent review, adjudication and quality reporting remain unfinished.
No evaluation corpus, registration, raw response or result belongs in this
application repository or its deployed assets.

## Preparation

Use an accepted external evaluation package containing `manifest.json`,
`PROTOCOL.md`, `README.md`, `validate.py`, `test_validate.py`, and the development
and held-out corpus files. The runner checks the frozen inventory, file sizes and
SHA-256 hashes. Development mode does not open or hash held-out bytes. Held-out
execution requires the complete registered 100-case roster and invokes the
package's pinned Python validator immediately before execution. Python 3 is
therefore needed for held-out execution only.

The package's candidate manifest is insufficient authorization to run. A separate
approved registration must provide every field below. Its protocol review must
precede registration. Actual application and evaluation Git HEADs must match the
registration, and tracked changes cause the CLI to stop. Record the accepted
remote commit in a genuine checkout; an independently initialized snapshot has a
different Git identity and is not interchangeable.

First obtain the frozen executor fingerprint without contacting any endpoint:

```sh
pnpm exec tsx scripts/evaluate-model.ts fingerprint \
  --endpoint http://127.0.0.1:4322 --model YOUR_EXISTING_LOCAL_MODEL \
  --max-tokens 320 --timeout-ms 28000
```

The output contains the executor file hash, complete captured research/verify
request templates, and their hashes. Templates contain the shipped system prompt,
JSON schemas, generation settings, model identity, and literal placeholders
`EVALUATION_SOURCE` / `EVALUATION_DRAFT`. Each actual request is also retained in
the private run artifacts. Template capture intercepts fetch in-process; it makes
no model or network call.

Keep the registration and output parent directory outside the application. This
example is a field guide, **not approved provenance**; substitute measured hashes,
actual accepted commits, identities, timestamps and the exact case roster:

```json
{
  "schema_version": 1,
  "experiment_id": "unique-experiment-id",
  "status": "approved",
  "mode": "development",
  "created_at_utc": "2026-09-26T00:00:00.000Z",
  "app_sha": "40-character accepted application commit",
  "evaluation_sha": "40-character accepted evaluation commit",
  "manifest_sha256": "64-character hash of original manifest bytes",
  "executor_sha256": "64-character executor fingerprint",
  "runtime_hash": "64-character runtime hash",
  "weights_hash": "64-character weights hash",
  "model_id": "YOUR_EXISTING_LOCAL_MODEL",
  "endpoint": "http://127.0.0.1:4322",
  "permitted_endpoints": ["http://127.0.0.1:4322"],
  "generation": {
    "temperature": 0,
    "max_tokens": 320,
    "timeout_ms": 28000,
    "concurrency": 1
  },
  "templates": {
    "research_sha256": "64-character captured template hash",
    "verify_sha256": "64-character captured template hash"
  },
  "machine": "Actual hardware and operating system description",
  "runtime_evidence": "Private evidence identifying the hashed runtime in use",
  "weights_evidence": "Private evidence identifying the hashed weights in use",
  "warm_up": "none; model already loaded; no excluded inference",
  "ordering_seed": 7,
  "case_ids": ["every exact registered case ID"],
  "arms": ["S", "P", "B"],
  "retry_policy": "one primary inference per stage; no retries",
  "protocol_review": {
    "reviewer": "Actual protocol reviewer",
    "approved_at_utc": "2026-09-25T00:00:00.000Z"
  },
  "reviewers": ["First independent reviewer", "Second independent reviewer"],
  "access_log": [
    {
      "identity": "Actual participant",
      "heldout_access": false,
      "excluded_from_tuning": false,
      "attested_at_utc": "2026-09-25T00:00:00.000Z"
    }
  ],
  "thresholds": {
    "structural_packages": 95,
    "independently_acceptable_packages": 90,
    "denominator": 100,
    "comparison": "descriptive-only"
  },
  "fixed_draft_variant": "claim-only"
}
```

Participants who have inspected held-out data must attest exclusion from tuning.
Registration values establish recorded provenance, not independent verification
of those attestations. The harness does not inspect runtime processes or weight
files; operators must establish that the existing server uses the recorded
runtime and weights. It does not start a model, download weights, install a
runtime, configure a paid provider or provide remote fallback.

## Dry run and execution

The default is a dry run: validate preparation and write the full unattempted
roster, without inference. The output directory must not already exist. Its
parent must already exist outside the application repository.

```sh
pnpm exec tsx scripts/evaluate-model.ts run \
  --registration /private/evaluation/registration.json \
  --evaluation /private/evaluation/corpus \
  --out /private/evaluation/new-dry-run
```

Only add `--execute` when the frozen registration is accepted and the existing
local runtime is ready. Only explicit numeric loopback origins are permitted:
`http://127.0.0.1:PORT` or `http://[::1]:PORT`. No DNS names, credentials, URL paths,
redirects or remote origins are accepted. This tool does not establish that a
loopback service itself avoids forwarding requests; that remains part of runtime
provenance review.

Execution uses a seeded Fisher–Yates case shuffle, alternating S-first and P-first
case pairs (50/50 for 100 cases). B follows each paired case. Each stage runs once,
serially, with no retries or excluded warm-up inference:

- **S:** one source-only research call.
- **P:** a separate source-only research call, then checking of that exact result.
  A failed research call skips checking; it never invents a draft.
- **B:** the source and `{ "claim": adversarial_draft.claim }`. Gold labels,
  evidence quotes, category, reasons and required facts never enter model input.

This tool calls the executor directly. It creates no owner account and advances
no application review or acceptance gate. Every record has empty owner actions,
null acceptance origin, two null reviewer scores and null adjudication.

## Retained evidence and reporting

A new run writes private files with exclusive creation and restrictive directory
permissions. The runner never overwrites/resumes a run or replaces a primary
attempt. Keep the entire directory; create a separately registered experiment
for any repeated inference. Files are append-only by runner behavior, not a
cryptographically authenticated or OS-enforced immutable archive.

`roster.json` is written before execution. Snapshots preserve the registration,
manifest, corpus and prompt/schema templates, with artifact hashes in `run.json`.
Each attempt and stage has a separate start record written before its call.
Terminal records link hashed input, parsed output, captured request and bounded
raw-response artifacts. A crash can therefore leave an explicit interrupted
attempt and retained partial stage work. SIGINT/SIGTERM stop further work and
retain the complete roster. `stop.json` records ordinary cancellation or dry-run
completion when the process can write it.

Raw response observation is process-exclusive because the frozen executor has no
observation hook. Run the CLI in a dedicated process. The observer temporarily
wraps global fetch, keeps the original executor's validation and transport, and
captures at most 64 KiB. The artifact records whether capture was complete,
observed HTTP status, finish reason and truncation evidence. Absence of evidence
is null. A `length` finish reason records truncation even when executor validation
rejects the response. Errors use safe fixed categories, never exception messages.
The shipped executor collapses network/HTTP failures to transport errors; this
runner does not invent a more specific availability diagnosis.

```sh
pnpm exec tsx scripts/evaluate-model.ts report --run /private/evaluation/run-id
```

Reports are recomputed from retained records, not saved summary totals. They
reject changed hashes/inputs, missing or duplicate roster members, unknown arms,
duplicate primary records and inconsistent stage ordering. Every arm retains its
full registered denominator, with attempted, completed, unattempted, interrupted
and ungraded counts. Available usage from failed stages and interrupted attempts
is retained; missing token usage is null. Token totals sum available records and
include explicit missing-usage counts, rather than treating absence as zero.

Latency summaries cover executor-call and harness end-to-end wall time, including
observation/file overhead as applicable. They are not GPU inference compute time.
Unfinished stages have no fabricated duration. Inference-only time, human review
minutes, CPU and peak memory are unmeasured and null.

This preparation does **not** implement independent review ingestion, blinded
review assignment, adjudication, confusion matrices, paired quality tables,
statistical tests, representative-task assessment or owner-effort measurement.
It consequently leaves quality unknown and E03/E14/E18 incomplete, including when
all calls finish. A development run is never the held-out gate.

## Deterministic verification

```sh
pnpm exec tsx --test --test-concurrency=1 tests/model-evaluation.test.ts
pnpm exec tsc --ignoreConfig --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --strict --skipLibCheck --types node \
  scripts/evaluate-model.ts tests/model-evaluation.test.ts
pnpm exec prettier --check scripts/evaluate-model.ts scripts/evaluation \
  tests/model-evaluation.test.ts docs/MODEL_EVALUATION.md
```

Tests use newly created synthetic fixtures and injected executors/fetch only. They
do not read the external held-out corpus, start a server or perform inference.
