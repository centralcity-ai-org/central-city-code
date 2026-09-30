# Owner-controlled source brief workflow

This local workflow keeps the supplied source, research brief, checker result and owner's final acceptance together. It uses existing native jobs and credentials. The hosted research/verify agents remain deterministic text demonstrations; an external agent runs only through its separately configured connector. A registered external agent is not evidence of model quality, independent verification or measured execution cost.

## Authority and stages

Choose three distinct reachable, non-revoked agents: requester, research-capability brief provider and verify-capability checker. The owner must authorize both directional connections, requester → researcher and researcher → reviewer. Only owner sessions can create/control workflows. Runtime credentials cannot create a workflow or advance its review gate; native/A2A agent-initiated jobs retain their existing hosted-only restrictions.

1. **Briefing:** create one native research job with the supplied source. No checker is started.
2. **Awaiting review:** the brief has completed. The owner reads the source and complete output, then explicitly starts the check.
3. **Checking:** create one native verify job whose input is `JSON.stringify({ source, draft })`. `source` is the full original text and `draft` is the complete brief output object. These are untrusted inputs; connectors must not treat them as tool or authority instructions.
4. **Completed:** both native jobs have completed. Completion does not accept the workflow.
5. **Accepted:** an explicit owner action accepts the completed pair. Both native jobs record owner acceptance; no payment occurs.

Generic job acceptance does not mark a workflow accepted. Active job failure/cancellation or revocation of either required grant/agent stops any unaccepted workflow, including one waiting at its review gate. Linked running/queued jobs are canceled atomically. An accepted workflow remains historical evidence after a later revocation. Cancellation cannot stop already-running external code or reverse effects, and late external results still fail native lease/state checks. These contracts remain pure-compute only.

Pause blocks new workflow creation, new checker admission, hosted execution and external result commits. It preserves the saved review state. Idempotent reads/retries and owner cancellation remain available. Final acceptance is a human record operation and can occur while paused. Restart preserves workflow/job relationships and retry evidence.

## API

All routes use the existing owner session; mutating requests require `Content-Type: application/json`, same origin and `X-City-Request: 1`.

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/workflows` | `{ requesterId, researcherId, reviewerId, source, idempotencyKey }` | HTTP 201 `WorkflowDetail` |
| `GET /api/workflows/:id` | No body | HTTP 200 `WorkflowDetail` |
| `POST /api/workflows/:id/check` | `{}` | HTTP 200 `WorkflowDetail` |
| `POST /api/workflows/:id/accept` | `{}` | HTTP 200 `WorkflowDetail` |
| `POST /api/workflows/:id/cancel` | `{}` | HTTP 200 `WorkflowDetail` |

`WorkflowDetail = { workflow, briefJob, checkJob }`; `checkJob` is null before the owner starts it. `Workflow` fields: `id`, `requesterId`, `researcherId`, `reviewerId`, `source`, `briefJobId`, nullable `checkJobId`, `status`, `createdAt`, `updatedAt`, nullable `error`. Statuses are `briefing`, `awaiting_review`, `checking`, `completed`, `accepted`, `failed`, `canceled`. IDs are UUIDs. Details read all retained linked jobs rather than only the latest 50-job snapshot.

An external provider may report a bounded execution failure via authenticated `POST /api/runtime/jobs/:id/failure` with `{ leaseToken, reason }`. Allowed reasons are `invalid-input`, `invalid-output`, `execution-timeout`, `runtime-unavailable`. These map to fixed provider-reported messages; arbitrary model errors, response text or credentials are never accepted in this payload. The route uses the same native runtime signature, current credential/provider/grant, pause, lease and terminal-state checks as result submission. A valid report immediately fails the job/workflow and records completion time. Repeating the same reason under the retained lease is idempotent; conflicting reasons, expired leases and canceled/completed work are rejected. This is a provider assertion, not an independent diagnosis. The credential does not gain permission to advance a workflow or accept results.

`Snapshot.workflows` returns all retained workflows newest first. The portable workspace export includes every retained workflow and job using explicit public-field allowlists; retry keys/hashes and future private storage fields are excluded. Exports contain user source/result content and should be kept private.

Create retries bind the owner's normalized source and exact participant IDs to the supplied idempotency key. Equal retries return the same workflow/jobs; changed input returns 409. The same key in another owner's workspace does not share authority or data. The reserved internal `workflow:` native-job namespace cannot be supplied through ordinary job admission. Checker requests are idempotent once the second job exists; they do not create a third job. Retries do not restore revoked authority.

## Bounds and failure behavior

Source is trimmed and limited to 4,000 characters. The complete serialized source plus brief must fit the existing 12,000-character native checker input limit. Oversized context is rejected with HTTP 409 and an explanation; no data is truncated, no checker is created and the original brief remains inspectable/exportable. External results retain native JSON-object, 32 KiB, depth/value and key restrictions. Rejecting a malformed/oversized result leaves the workflow waiting on its current brief job.

At most 200 retained workflows per workspace. Existing limits also apply: 1,000 retained jobs, two active jobs per agent, ten active jobs per workspace, bounded events/presence and HTTP input. Hitting a retention cap refuses new work and preserves history; portable export alone does not clear the cap or provide an archival/delete operation. A failed/canceled workflow is not silently retried; inspect it and create a new workflow. Hosted work has known zero external API cost; external work continues to report `costCents: null` because its cost is not measured here.

## Persistence and recovery

Workflows are an optional bounded array in the existing transactional workspace row. No new database table or migration is required. The current app treats an absent array as empty. The current offline backup/restore parser accepts old format-v1 backups without workflows and validates new workflow IDs, participants, linked job identities/capabilities and stage consistency. Accepted/failed/canceled workflow history is retained. Restore cancels every other workflow, including a completed pair pending owner acceptance, pauses the workspace, resets presence and clears runtime/session authority. It does not resume at a review gate or replay jobs.

Compatibility is directional: the new restore implementation reads old backups. The old strict restore implementation rejects new backups containing workflow fields; this is not a safe downgrade path. Do not remove workflow fields merely to force a downgrade, since doing so discards relationships and review history. Preserve a verified backup and use the current implementation for restoration. The backup remains sensitive, unencrypted and intended for trusted local use.

## Verification and limits

`pnpm exec tsx --test tests/workflows.test.ts tests/recovery.test.ts tests/workspace-export.test.ts` verifies owner isolation, explicit gates, duplicate/conflicting requests, terminal transitions, pause, revoked directions, cancel/check races, external output/context bounds, all-history detail/export, persistence, isolated restore and old backups. TypeScript and the ordinary app suite remain regression gates. Source/job history and state transitions establish implementation behavior, not factual accuracy, customer value, independent agents or production uptime.

Rollback should preserve workflow-bearing workspace data and use the current recovery reader. Disabling workflow routes/UI is reversible without rewriting stored records; running an older app against newer data is not a verified downgrade procedure. No hosted pilot, public deployment, paid model call, browsing or financial action is created by this workflow feature.
