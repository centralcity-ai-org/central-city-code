# Operations runbook

This is a procedure, not evidence that a deployment, recovery drill or service objective has passed. Confirm the running commit and current configuration before acting. Never copy production records into a test environment.

## Release record

Use one release owner at a time. Record application SHA, migration versions, reviewed PR, exact-head checks, deployment ID, environment, release time and previous known-good deployment. Environment values and credentials do not belong in the record. A ready preview does not mean the production alias changed.

Before release:

1. Confirm exact-head review and required CI; inspect failures rather than treating a rerun as proof a defect was fixed.
2. Run the relevant tests plus `pnpm build`, `pnpm check:boundaries` and `pnpm format:check`. Use the repository-pinned package manager. Changes to authentication, storage or routing require their focused regression tests.
3. Inspect migration compatibility. Do not edit an applied migration. A build that does not recognize an already-applied version can refuse startup; an older code deployment is not automatically a safe rollback.
4. Verify environment identity and database isolation. A protected preview can still write production data if it shares credentials. Do not send synthetic load to a preview until its database is independently verified as disposable.
5. Deploy through the configured release owner/workflow. Verify the resulting deployment ID and SHA, then verify the production alias separately. This document does not change deployment protection or authorize public release of internal records.

## Verification after deployment

Run `node scripts/connection-doctor/cli.mjs https://centralcity.ai`. It checks public reachability, metadata and the authentication challenge; it does not prove sign-in, consent, messaging or model execution.

For a messaging change, use a dedicated synthetic account: verify the actual console conversations route, send a uniquely identified message, read the exact message ID and sequence, and verify acknowledgement. Check the browser error/retry state as well as the HTTP response. Read-only checks alone do not certify sending. Test an expected unauthorized request too; a success-only probe can miss lost isolation.

Until the canary is configured and live-verified, it must not be described as deployed coverage. Its dedicated account and scoped alert credentials must never be substituted with a customer or shared team account.

Record expected versus observed status, latency, deployment SHA and test identity without storing session cookies, tokens, raw private content or complete database URLs. A hosted deterministic demo is not proof that an external model executed work.

## Incident handling

1. Record UTC onset, affected route/flow, last known-good deployment and observed impact. Distinguish confirmed failures from hypotheses.
2. Establish one incident owner. Preserve sanitized logs and request identifiers. Avoid multiple simultaneous deploys, database changes and credential rotations.
3. Check public reachability, authentication status, function startup/configuration, database connectivity and recent migrations in that order when appropriate. A 401 suggests authentication; a 400 requires checking the actual request and rewrite path; a 503 may reflect startup or dependency failure. Status alone does not establish cause.
4. Reproduce with a synthetic account and the deployed route. Do not expose user content in issue comments. For the historical Messages 400 bug, compare the actual query seen by the hosted adapter with strict route validation; a local direct Fastify request does not exercise Vercel rewriting.
5. Mitigate with the smallest reviewed change or compatible rollback. Pause affected execution only through authorized controls; revocation does not stop arbitrary external processes already running.
6. Verify the affected positive flow and a relevant negative/isolation flow. Record resolution time, evidence, residual risk and follow-up owner. Do not announce recovery from deployment readiness alone.

If the alert channel is unavailable, retain the incident locally and use another authorized channel. An alert sent through the same failing platform is not an independent availability guarantee.

## Rollback decision

First determine whether the problem is code, configuration, data or an external service. Compare the previous build's schema support with current migrations. Prefer a forward repair when rollback would restore weaker authorization or reject the schema.

For a code-only compatible rollback, use the existing deployment controls to select a reviewed known-good deployment and confirm its alias/commit after promotion. Do not revert database contents as an incidental rollback step. A restore can resurrect credentials, grants, invitations or stale work; it is a separate recovery operation needing an isolated drill and authority reconciliation.

After rollback, repeat the affected authenticated flow, public doctor and negative authorization checks. Preserve the failed release evidence.

## Credential rotation

Use the owner credential-rotation action described in [CREDENTIALS.md](CREDENTIALS.md). It preserves agent identity, replaces authority and cancels queued/running jobs involving the agent. The secret is shown once; a lost response does not justify blindly retrying. Verify old-secret rejection and new-secret operation without logging either secret.

Application runtime credentials, OAuth grants, database credentials, rate-limit keys and Agent Card signing keys are different secrets with different consumers. Inventory consumers and revocation/overlap behavior before rotating each class. Do not assume the agent rotation endpoint rotates other secrets. Never place a server secret under a VITE_ variable or in browser assets.

A signing-key change needs verification of published JWKS and existing-card validity policy. A rate-limit-key change may change counter identity. A database credential change must cover every authorized deployment environment without accidentally linking preview to production. Record identifiers and timestamps, never secret values.

## Recovery and evidence gaps

[RECOVERY.md](RECOVERY.md) describes offline local PGlite backup/restore into a new directory. It is not the Neon disaster-recovery procedure. Never apply those local commands to production PostgreSQL or claim that a logical roundtrip measures managed recovery time.

The Neon drill requires a verified disposable resource, protected-endpoint inventory, synthetic data, tested credential invalidation and consent reconciliation. Measure recovery-point loss and elapsed recovery time; RPO/RTO remain unknown until measured. Preserve current customer data throughout.

## Observability and proposed service objective

Proposed initial objective for team review: at least 99.5% successful eligible synthetic messaging probes over a rolling 30-day window. Count only scheduled probes with valid configured credentials as eligible; report missing observations and credential failures separately, never silently as success. Also report 401/403,429 and dependency errors separately so admission controls are not mistaken for service health.

Error budget = eligible probes times 0.005. Report both numerator and denominator; sparse or missing samples cannot substantiate availability. A 30-minute canary can miss brief outages. No numerical production SLO is claimed as adopted or met here.

Structured request IDs, redacted application logs and operational dashboards are a separate implementation item. This runbook does not claim those controls exist. Never log Authorization, Cookie, database URLs, invitation/claim tokens, message bodies or model prompts. When correlating an incident, use an opaque request ID and approved aggregate metadata.
