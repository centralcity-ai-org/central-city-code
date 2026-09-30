# Disposable Neon load-test adapter

`scripts/neon-load/index.ts` provides a guarded PostgreSQL connection and a separate contention sampler for synthetic load tests. It is a reusable helper, not another load generator. Wiring it into the shared load harness is a separate integration step.

## Required inputs

Pass an explicit database URL, the exact disposable Neon endpoint identifier, and a nonempty list of forbidden production/staging endpoint identifiers. The helper does not read `DATABASE_URL` from the environment. Keep URLs and credentials in private process inputs; never commit or print them.

The helper compares normalized endpoint identities, including direct and `-pooler` aliases. Hostnames and PostgreSQL URLs can also identify forbidden endpoints. Malformed configuration fails before constructing a connection pool. This version accepts AWS Neon hostnames on port 5432. Supply a URL without query options, or with only `sslmode=verify-full`; other query options are rejected. Connections use explicitly parsed fields and verified TLS; URL options cannot override the target or disable certificate verification.

Provision a fresh, disposable database before using the helper. A normal Neon branch can inherit existing relations and data. The read-only catalog preflight rejects user relations, custom schemas, functions and types before handing a database to the callback. It never drops or clears an existing database. An endpoint label and an empty database are safeguards, not independent proof that a resource is disposable: the operator must verify branch ownership and supply the complete forbidden list.

The catalog check covers those application-object categories, not every PostgreSQL object class. For example, it does not inspect large-object metadata or collations. Extension-owned schemas, functions and types are excluded; extension-owned relations are still refused. A passing preflight must never substitute for provisioning and verifying a fresh disposable database.

## Integration contract

```ts
import { withDisposableNeon } from '../scripts/neon-load/index.js';

const report = await withDisposableNeon(
  {
    databaseUrl: privateDisposableUrl,
    disposableEndpoint: disposableEndpointId,
    forbiddenEndpoints: protectedEndpointIds,
    poolSize: 3,
  },
  async ({ database, sampler }) => {
    // Only synthetic schema/data belongs in this callback.
    await prepareSyntheticSchema(database);
    sampler.start();
    return await runSyntheticScenarios(database);
  },
);
```

The example shows the integration boundary; `prepareSyntheticSchema` and `runSyntheticScenarios` are supplied by the harness. The adapter uses the application's `postgresDatabase` implementation. The application pool defaults to three connections; the sampler uses a separate single-connection pool. Always await all database work inside the callback. The helper owns pool cleanup: a hosted application using this borrowed database must not independently close the underlying pool. The helper stops sampling and attempts to close both pools on success or failure. It does not provision or delete cloud resources.

The current phase-0 harness has its own child-process lifecycle, instrumentation reset and stats messages. Integration must keep the callback alive until that child is stopped, forward only explicit private load configuration, and report sampler results without raw driver errors. Do not enable the old permissive Neon guard as a shortcut: replace the substring branch check with this exact endpoint check and run preflight before schema creation or seeding. A fresh database is required for each run; existing `load-` operator names do not prove that a database is safe to reuse.

## What the measurements mean

Sampling defaults to 250 ms. Queries are restricted to the current database and the unique application name for this run. Reports aggregate bounded categories rather than storing SQL text, credentials, hostnames or backend identifiers.

`SELECT 1` round-trip time is reported separately from database wait and lock observations. Sampled occupancy is not wait duration and cannot establish the cause of a slow request. Short waits between samples may be missed; delayed samples reduce coverage. Inspect sample error counts and completed sample counts before interpreting a report. Sampling itself adds one connection and query overhead.

These checks do not establish production capacity. A comparison requires the same application commit, scenario inputs, pool size and measurement method, plus explicit compute size, region, network conditions and cold/warm state. Record request latency and failures alongside the sampler output. A successful synthetic unit test is not a live Neon benchmark.

## Live-run checklist

1. Verify the task-created branch and fresh database, record its resource identity privately, and identify every protected endpoint.
2. Use synthetic data only. Keep secrets out of command history, test artifacts and PRs.
3. Run a bounded smoke test before scenarios and pool sweeps. Do not interpret a preflight failure as permission to clear a database.
4. Record application SHA, scenario parameters, request results, sampler coverage, compute configuration, elapsed time and actual cost if available.
5. Clean up only resources created for this test, through the authorized resource-management workflow. Pool cleanup does not delete a Neon branch or stop its billing.

## Local verification

Run `pnpm exec tsx --test tests/neon-load.test.ts` and `pnpm typecheck`. Tests inject fake pools and do not connect to Neon. A live run remains a separate acceptance criterion.
