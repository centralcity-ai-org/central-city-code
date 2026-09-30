# Load harness (phase 0, local)

Measures today's application under synthetic load and writes a baseline report. It runs the
real `createApp` in **hosted mode** (the production code path: `https://` origin checks,
`X-Forwarded-For` behind one trusted hop, PostgreSQL-backed rate limiter, no background worker)
against an **in-process PGlite** database, in a child process on `127.0.0.1` with an ephemeral
port. Nothing leaves the machine.

```sh
pnpm load:local                         # both limit profiles, default small profile (~4 min on an M3)
pnpm load:local --limits=off            # one profile
pnpm load:local --owners=40 --agents=40 --s1-seconds=120 --s3-jobs=950
pnpm load:local --scenarios=S5,S2 --s2-levels=1,8,32 --s2-seconds=10
```

| flag                                                                              | default              | meaning                                                      |
| --------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------ |
| `--limits`                                                                        | `both`               | `off`, `on` or `both` (one fresh server per profile)         |
| `--owners`, `--agents`, `--hosted`                                                | 10, 20, 4            | seeded owners; agents per owner; how many of them are hosted |
| `--scenarios`                                                                     | `S5,S1,S2,S3,S4`     | subset and order                                             |
| `--s1-seconds`, `--s1-poll-ms`, `--s1-submit-ms`, `--s1-request-ms`               | 40, 2000, 1000, 8000 | S1 duration and pacing                                       |
| `--s2-levels`, `--s2-seconds`                                                     | `1,2,4,8,16,32`, 6   | S2 concurrency levels and seconds per level                  |
| `--s3-jobs`, `--s3-output-bytes`, `--s3-bucket`, `--s3-pairs`, `--s3-concurrency` | 420, 2048, 60, 16, 4 | S3 size                                                      |
| `--s4-creates`, `--s4-concurrency`                                                | 120, 8               | S4 creates per phase                                         |

Reports go to `.local/load/<runId>/report.json` and `summary.md` (gitignored). They include
the app commit, Node version, machine, options, per-route p50/p95/p99/max, rps and status
histograms, database instrumentation and event-loop delay. Tokens, cookies, passwords,
signatures, nonces and idempotency keys are never recorded; report keys that look like secrets
are redacted again before writing.

## Pieces

| file                        | role                                                                                                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run.ts`                    | CLI and orchestration; one fresh server child per limit profile                                                                                                             |
| `server.ts`                 | child: `createApp({ hosted, database })` on `https://load.test`, random in-memory `CITY_RATE_LIMIT_KEY`, inherits no `CITY_*`/`DATABASE_URL`/`VERCEL*` environment          |
| `instrument.ts`             | `Database` wrapper: transaction wait, `workspaces … FOR UPDATE` acquire, lock hold (lock → commit), workspace blob bytes per `UPDATE`, time per SQL shape                   |
| `client.ts`                 | keep-alive `node:http` client, cookie jar, `X-City-Request: 1`, `X-Forwarded-For` from 198.18.0.0/15, runtime HMAC signing via `connector/signing.ts`; classifies responses |
| `seed.ts`                   | via the API: owners `load-<runId>-o0001…`, external + hosted agents, connections, first heartbeats                                                                          |
| `scenarios/`                | S1–S5 (below)                                                                                                                                                               |
| `guard.ts`                  | target guards on `scripts/guards/database.ts` (unit-tested in `tests/load-guard.test.ts`, `tests/guards.test.ts`)                                                           |
| `histogram.ts`, `report.ts` | exact-sample percentiles; JSON + Markdown output                                                                                                                            |

## Scenarios

- **S5 correctness probes** (runs first): signed-request nonce replay → 409; stale heartbeat
  sequence → 409; forged signature → 401; job idempotency (same key → same id, changed input →
  409); result idempotency; anonymous-creation idempotency (same key → same agent).
- **S1 runtime steady state**: every external agent runs a connector-like loop (poll
  `GET /api/runtime/jobs` ~2 s, heartbeat ~20 s, submit results, native requests to hosted
  providers and polling them); every owner submits jobs, accepts results and polls the snapshot.
  Client budgets keep each workspace within the default active-job caps so both profiles offer
  the same valid load.
- **S2 hot owner**: one owner per level with N = 1…32 concurrent connector pairs running full job
  cycles (submit → claim → result → accept) against one workspace row.
- **S3 blob growth**: one owner accumulates jobs with padded results; mutation p95 per bucket vs
  workspace blob size.
- **S4 anonymous creation**: `POST /api/public/agents` from one source vs spread over many /24s.

## Limit profiles

- `--limits=off`: always-allow rate limiter and very high capacity caps (the checks still run).
- `--limits=on`: the application defaults (PostgreSQL rate limiter, reviewed v0.5 caps).

Outcomes are `ok` (2xx), `expected` (a probe's intended status), `refused` (429, or 409/503 with
a capacity/limit message — intentional bounds) and `error` (everything else, including
transport failures). A healthy run has close to zero errors.

## Targets and guards

`--target=local` is the only executable target. `--target=neon` runs every guard and then stops
with "not yet supported". Target parsing and comparison live in `scripts/guards/database.ts`
(shared, exact matches only, never substrings); `guard.ts` wraps them. The guards refuse unless:

- `LOAD_DATABASE_URL` is a `postgres://` URL with one host, no fragment and `sslmode=verify-full`
  as its only query parameter (so `?host=` or `?options=` cannot redirect the client, and
  `PGSSLMODE` cannot weaken TLS), on a Neon endpoint host (`ep-….neon.tech`, direct or
  `-pooler`), and `PGOPTIONS` is not set;
- its endpoint id is not on the forbidden list: the mandatory `LOAD_FORBIDDEN_ENDPOINTS`, where
  every entry must be an `ep-` id, a Neon host or a Neon postgres URL (a trimmed or mistyped host
  is refused rather than silently ignored), **plus the shell's `DATABASE_URL`, added
  automatically** (a `DATABASE_URL` that cannot be parsed is refused);
- `--disposable-endpoint=ep-…` (or its host) names **exactly** that endpoint. The older
  `--disposable-branch` flag is still read. A `br-…` branch id is refused, because the host
  cannot prove which branch it belongs to;
- nothing in it resolves to `centralcity.ai`, `*.vercel.app` or the production origin
  (`LOAD_PRODUCTION_ORIGIN`, `CITY_PUBLIC_ORIGIN`).

Before any write, the target must be catalog-empty: `CATALOG_EMPTY_SQL` (no user schemas,
relations, functions or types; the same check as `scripts/neon-load`) and `checkDatabaseEmpty`
on its row, which fails closed. Each run therefore needs a fresh disposable branch.
`preflight` returns the validated URL string frozen; the Neon runner must connect with exactly
that value and never re-read `LOAD_DATABASE_URL`.

## Caveats

PGlite is single-connection and in-memory PGlite queries complete synchronously inside the
server's event loop, so every transaction in the process is serialized and "tx wait" stays near
zero: queueing shows up as event-loop delay and request latency instead. Lock hold here is the
CPU time spent inside a workspace transaction (read, parse, mutate, stringify, write), not
multi-connection PostgreSQL row-lock contention. The client and server share one machine. Use the numbers as a relative
baseline (before/after a change on the same machine), not as production capacity.
