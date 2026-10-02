import { registerMigration, type Migration } from '../migrations.js';
import { registerElricEraseMigration } from './erase.js';

/**
 * Migration 39 `elric_core` (docs/ELRIC.md). The schema always exists; the feature is behind
 * CITY_ELRIC=1. No foreign keys to rooms: every read and write goes through elricRoomAccess.
 *
 * - `elric_verified_identities`: a server-stored verified identity per operator (provider
 *   'google'), written only by the future Google sign-in after it verified an ID token
 *   (email_verified=true). Eligibility reads only this table, never a client claim.
 * - `elric_agents`: the first-party marker for one workspace agent of a person owner. At most one
 *   non-revoked Elric per owner. `status` is written only by the owner console (paused/revoked
 *   stop reads and writes); `host_may_invoke` (default off) lets the room host invoke it too.
 * - `elric_flags`: the database kill switch (name 'kill').
 * - `elric_usage` / `elric_global_usage`: per owner and UTC day allowance counters, and the
 *   global cost-unit ceiling, reserved together in one transaction under row locks.
 * - `elric_invocations`: one row per (Elric agent, room, mention seq): the idempotency key, the
 *   lease and the reservation of an invocation.
 * - `elric_notices`: the "Elric answers only its owner" notice shown to a sender, at most once
 *   per sender, room and day. Never posted into the room.
 * - `elric_turns`: the append-only, owner-queryable turn log (trigger-enforced).
 * - `elric_posts`: which room messages Elric posted, with model and tier (attribution).
 * - `elric_pending_actions`: consequential tool calls awaiting the owner's approval, with the
 *   exact stored arguments and their hash, and an expiry.
 */
export const ELRIC_TABLES = [
  'elric_agents',
  'elric_flags',
  'elric_global_usage',
  'elric_invocations',
  'elric_notices',
  'elric_pending_actions',
  'elric_posts',
  'elric_turns',
  'elric_usage',
  'elric_verified_identities',
] as const;

/**
 * The turn outcomes migration 39 created its CHECK with. Frozen: migration 39's SQL (and its
 * checksum) must never change. New outcomes are added below and by a later migration.
 */
const ELRIC_OUTCOMES_V39 = [
  'ok',
  'step_limit',
  'refused_invoker',
  'refused_ineligible',
  'refused_access',
  'refused_inactive',
  'refused_kill',
  'refused_credential',
  'limit',
  'cancelled',
  'expired',
  'error',
] as const;
/**
 * Every turn outcome. 'pending' (migration 40): the run asked for a consequential tool, which now
 * waits for the owner's approval as a pending action; nothing was executed.
 */
export const ELRIC_OUTCOMES = [...ELRIC_OUTCOMES_V39, 'pending'] as const;
export type ElricOutcome = (typeof ELRIC_OUTCOMES)[number];

const sqlList = (items: readonly string[]) => items.map((item) => `'${item}'`).join(',');
const outcomes = sqlList(ELRIC_OUTCOMES_V39);

export const ELRIC_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS elric_verified_identities (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 255),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 320),
  email_verified boolean NOT NULL,
  verified_at bigint NOT NULL,
  created_at bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS elric_verified_identities_subject
  ON elric_verified_identities(provider, subject);
CREATE TABLE IF NOT EXISTS elric_agents (
  agent_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','revoked')),
  host_may_invoke boolean NOT NULL DEFAULT false,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, updated_by text NOT NULL,
  revoked_at bigint, revoked_by text
);
CREATE UNIQUE INDEX IF NOT EXISTS elric_agents_one_per_owner
  ON elric_agents(owner_id) WHERE status <> 'revoked';
CREATE TABLE IF NOT EXISTS elric_flags (
  name text PRIMARY KEY CHECK (name IN ('kill')),
  enabled boolean NOT NULL,
  updated_at bigint NOT NULL, updated_by text NOT NULL
);
CREATE TABLE IF NOT EXISTS elric_usage (
  owner_id text NOT NULL, day text NOT NULL,
  short integer NOT NULL DEFAULT 0 CHECK (short >= 0),
  summary integer NOT NULL DEFAULT 0 CHECK (summary >= 0),
  tool integer NOT NULL DEFAULT 0 CHECK (tool >= 0),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  spent_units bigint NOT NULL DEFAULT 0 CHECK (spent_units >= 0),
  PRIMARY KEY (owner_id, day)
);
CREATE TABLE IF NOT EXISTS elric_global_usage (
  day text PRIMARY KEY,
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  spent_units bigint NOT NULL DEFAULT 0 CHECK (spent_units >= 0),
  invocations integer NOT NULL DEFAULT 0 CHECK (invocations >= 0)
);
CREATE TABLE IF NOT EXISTS elric_invocations (
  agent_id text NOT NULL, room_id text NOT NULL, source_seq bigint NOT NULL,
  owner_id text NOT NULL, invoker_member_id text NOT NULL,
  invoker_kind text NOT NULL CHECK (invoker_kind IN ('owner','host')),
  status text NOT NULL CHECK (status IN ('queued','running','done','cancelled')),
  lease_id text, locked_until bigint,
  kind text CHECK (kind IN ('short','summary','tool')),
  reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  usage_day text,
  created_at bigint NOT NULL, finished_at bigint,
  PRIMARY KEY (agent_id, room_id, source_seq)
);
CREATE INDEX IF NOT EXISTS elric_invocations_open ON elric_invocations(status, created_at)
  WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS elric_notices (
  room_id text NOT NULL, sender_member_id text NOT NULL, day text NOT NULL,
  source_seq bigint NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY (room_id, sender_member_id, day)
);
CREATE TABLE IF NOT EXISTS elric_turns (
  id text PRIMARY KEY,
  owner_id text NOT NULL, agent_id text NOT NULL, room_id text NOT NULL,
  invoker_member_id text NOT NULL,
  invoker_kind text NOT NULL CHECK (invoker_kind IN ('owner','host','other')),
  source_seq bigint NOT NULL,
  context_from_seq bigint, context_to_seq bigint,
  tier smallint CHECK (tier IN (0,1,2)),
  model text,
  input_tokens integer NOT NULL DEFAULT 0, output_tokens integer NOT NULL DEFAULT 0,
  cost_units bigint NOT NULL DEFAULT 0,
  reserved_units bigint NOT NULL DEFAULT 0,
  tool_calls jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome text NOT NULL CHECK (outcome IN (${outcomes})),
  reason text,
  posted_seq bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS elric_turns_owner ON elric_turns(owner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS elric_turns_room ON elric_turns(room_id, source_seq);
CREATE OR REPLACE FUNCTION elric_turns_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'elric_turns is append-only';
END;
$$;
CREATE TRIGGER elric_turns_append_only BEFORE UPDATE OR DELETE ON elric_turns
  FOR EACH ROW EXECUTE FUNCTION elric_turns_append_only();
CREATE TRIGGER elric_turns_no_truncate BEFORE TRUNCATE ON elric_turns
  FOR EACH STATEMENT EXECUTE FUNCTION elric_turns_append_only();
CREATE TABLE IF NOT EXISTS elric_posts (
  room_id text NOT NULL, seq bigint NOT NULL,
  agent_id text NOT NULL, owner_id text NOT NULL,
  model text, tier smallint NOT NULL CHECK (tier IN (0,1,2)),
  turn_id text NOT NULL,
  PRIMARY KEY (room_id, seq)
);
CREATE TABLE IF NOT EXISTS elric_pending_actions (
  id text PRIMARY KEY,
  owner_id text NOT NULL, agent_id text NOT NULL, room_id text NOT NULL,
  tool text NOT NULL CHECK (char_length(tool) <= 64),
  args jsonb NOT NULL, args_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','approved','rejected','expired','failed')),
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL, decided_at bigint, decided_by text,
  result jsonb
);
CREATE INDEX IF NOT EXISTS elric_pending_actions_owner ON elric_pending_actions(owner_id, status);
`;

export const elricMigration: Migration = {
  version: 39,
  name: 'elric_core',
  sql: ELRIC_MIGRATION_SQL,
};

/**
 * Migration 40 `elric_waking` (docs/ELRIC_MODEL.md):
 * - `elric_invocations.waking_since`: set when a self-hosted endpoint answered "waking" (scaling
 *   from zero); the owner sees "Elric is waking up…" until the model answers or the wake deadline
 *   (measured from here) gives up with a refund;
 * - `deferred_at`: the run was put back cleanly (cold start, or too little time left in this
 *   function run); the next drain resumes it with the same reservation (not-before time in
 *   `locked_until`);
 * - `spent_units` / `inflight_units`: the units already spent, and the estimate of a model call in
 *   flight, so a run cut off mid-flight settles what it really spent instead of the whole
 *   reservation;
 * - the `elric_turns` outcome CHECK also allows 'pending' (a consequential tool call waiting for
 *   the owner's approval).
 * No new table: the offline backup's Elric table list is unchanged. The list is written out here
 * (frozen), never derived from ELRIC_OUTCOMES, so this migration's checksum never changes either.
 */
export const elricWakingMigration: Migration = {
  version: 40,
  name: 'elric_waking',
  sql: `
ALTER TABLE elric_invocations ADD COLUMN IF NOT EXISTS waking_since bigint;
ALTER TABLE elric_invocations ADD COLUMN IF NOT EXISTS deferred_at bigint;
ALTER TABLE elric_invocations ADD COLUMN IF NOT EXISTS spent_units bigint NOT NULL DEFAULT 0
  CHECK (spent_units >= 0);
ALTER TABLE elric_invocations ADD COLUMN IF NOT EXISTS inflight_units bigint NOT NULL DEFAULT 0
  CHECK (inflight_units >= 0);
ALTER TABLE elric_turns DROP CONSTRAINT IF EXISTS elric_turns_outcome_check;
ALTER TABLE elric_turns ADD CONSTRAINT elric_turns_outcome_check
  CHECK (outcome IN (${sqlList([...ELRIC_OUTCOMES_V39, 'pending'])}));
`,
};

/** Idempotent; call before runMigrations (createApp registers it unconditionally). */
export function registerElricMigration(): void {
  registerMigration(elricMigration);
  registerMigration(elricWakingMigration);
  registerElricEraseMigration();
}
