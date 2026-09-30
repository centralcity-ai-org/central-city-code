import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 16 `published_results` ("Answers" (v1), exchange before compute; docs/ANSWERS.md).
 *
 * - `operators.created_at`: account creation time (epoch ms), backfilled with the migration time so
 *   existing accounts become eligible principals 7 days after this migration. New rows default to
 *   the insert time; registration sets it from the app clock.
 * - `published_results`: one deliberately published result. `owner_id` cascades on account
 *   deletion (idle AI-workspace reclaim, unclaimed purge). `agent_name` and `owner_label` are
 *   stamped at publish so an ask never loads another owner's workspace JSON. `principal_id` is the
 *   publisher's eligible principal at publish (the kind='owner' account, or the earliest human
 *   co-owner of an AI workspace), used for the per-principal caps. `search_body` and
 *   `search_sources` are plain text computed by the service; the generated `search` vector is
 *   empty once a row is revoked (title null, both texts ''), and the partial GIN index drops it.
 *   `flag_count`, `reuse_count` and `hidden_at` are stored and updated in the report's transaction.
 *   `suspended_at` is set while the publishing agent or its workspace is paused.
 * - `result_receipts`: idempotency per (owner, key), shared by MCP and REST and bound to the
 *   request hash (which includes the operation). 'delegate' and `delegation_id` are reserved (v2).
 * - `result_asks`: which results an ask returned. Nothing derived from the question is stored.
 * - `reuse_events`: one report per (ask, result). `ask_id` is SET NULL by the 30-day ask sweep so
 *   stored flags and counts survive it. `principal_id` and `counted` are stamped at report time; no
 *   network identifier is stored (the 24 h per-network dedup is a rate-limit key).
 */
export const RESULT_TABLES = [
  'published_results',
  'result_asks',
  'result_receipts',
  'reuse_events',
] as const;

export const resultsMigration: Migration = {
  version: 16,
  name: 'published_results',
  sql: `
ALTER TABLE operators ADD COLUMN IF NOT EXISTS created_at bigint;
UPDATE operators SET created_at=(extract(epoch from now())*1000)::bigint WHERE created_at IS NULL;
ALTER TABLE operators ALTER COLUMN created_at SET DEFAULT (extract(epoch from now())*1000)::bigint;
ALTER TABLE operators ALTER COLUMN created_at SET NOT NULL;
CREATE TABLE IF NOT EXISTS published_results (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  principal_id text,
  agent_id text NOT NULL, agent_name text NOT NULL, owner_label text NOT NULL,
  title text, parts jsonb, sources jsonb, method text,
  license text NOT NULL, terms text,
  visibility text NOT NULL CHECK (visibility IN ('public','workspace','room')),
  room_id text,
  content_hash text NOT NULL,
  search_body text NOT NULL DEFAULT '',
  search_sources text NOT NULL DEFAULT '',
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title,'')),'A') ||
    setweight(to_tsvector('simple', search_body),'B') ||
    setweight(to_tsvector('simple', search_sources),'C')
  ) STORED,
  source_count integer NOT NULL DEFAULT 0 CHECK (source_count >= 0),
  flag_count integer NOT NULL DEFAULT 0 CHECK (flag_count >= 0),
  reuse_count integer NOT NULL DEFAULT 0 CHECK (reuse_count >= 0),
  hidden_at bigint, suspended_at bigint,
  created_at bigint NOT NULL, expires_at bigint,
  revoked_at bigint, revoked_by text,
  revoked_reason text CHECK (revoked_reason IN ('unpublish','agent_revoked','room_removed')),
  CHECK (revoked_at IS NOT NULL OR title IS NOT NULL),
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL)),
  CHECK ((visibility = 'room') = (room_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS published_results_search ON published_results USING gin(search) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS published_results_owner ON published_results(owner_id, created_at);
CREATE INDEX IF NOT EXISTS published_results_visibility ON published_results(visibility, created_at);
CREATE INDEX IF NOT EXISTS published_results_room ON published_results(room_id) WHERE room_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS published_results_agent ON published_results(agent_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS published_results_principal ON published_results(principal_id) WHERE visibility='public' AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS published_results_revoked ON published_results(revoked_at) WHERE revoked_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS published_results_dedupe ON published_results(owner_id, content_hash, visibility, coalesce(room_id,'')) WHERE revoked_at IS NULL;
CREATE TABLE IF NOT EXISTS result_receipts (
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('publish','unpublish','delegate')),
  request_hash text NOT NULL,
  result_id text, delegation_id text,
  deduplicated boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL,
  PRIMARY KEY(owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS result_receipts_created ON result_receipts(created_at);
CREATE TABLE IF NOT EXISTS result_asks (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  agent_id text NOT NULL, result_ids text[] NOT NULL, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS result_asks_created ON result_asks(created_at);
CREATE TABLE IF NOT EXISTS reuse_events (
  id text PRIMARY KEY,
  ask_id text REFERENCES result_asks(id) ON DELETE SET NULL,
  result_id text NOT NULL REFERENCES published_results(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  principal_id text, agent_id text NOT NULL, used boolean NOT NULL,
  reason text CHECK (reason IN ('used','irrelevant','stale','wrong','spam','injection')),
  tokens_avoided bigint CHECK (tokens_avoided >= 0),
  latency_avoided_ms bigint CHECK (latency_avoided_ms >= 0),
  baseline_method text, request_hash text NOT NULL,
  counted boolean NOT NULL DEFAULT false, created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reuse_events_pair ON reuse_events(ask_id, result_id);
CREATE INDEX IF NOT EXISTS reuse_events_counted ON reuse_events(result_id, principal_id) WHERE counted;
`,
};

/** Idempotent; call before runMigrations (after the wake migration). */
export function registerResultsMigration(): void {
  registerMigration(resultsMigration);
}
