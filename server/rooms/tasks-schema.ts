import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 24 `room_tasks` (room tasks, claims core; docs/ROOM_TASKS.md).
 *
 * - `room_tasks`: one work item in a room. `number` is the per-room T-number (T1, T2, …),
 *   allocated under the room row lock, so concurrent creates never collide.
 *   `attachment_ids` is a plain `text[]` with no foreign key: the service validates each
 *   id against the step-1 attachments table and refuses with `409 attachment_not_ready`.
 * - `room_task_events`: append-only audit of task transitions. Read paged by
 *   `(task_id, created_at)`; nothing ever deletes from it.
 * - Claim invariant (binding review note 3): `(status = 'claimed') = (claim_agent_id
 *   IS NOT NULL)`, with the token hash and expiry null exactly when the holder is null.
 *   Every path that treats an expired lease as open (lapse on read, post-grace claim
 *   takeover, release) clears or replaces the whole `claim_*` group and sets the status
 *   in the same statement, so the CHECK can never observe a half-lapsed row.
 * - No presence columns here (binding review note 1): member activity reuses
 *   `room_members.last_active_at` (migration 21) through `touchMembers`.
 */
export const roomTasksMigration: Migration = {
  version: 24,
  name: 'room_tasks',
  sql: `
CREATE TABLE IF NOT EXISTS room_tasks (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  number integer NOT NULL CHECK (number >= 1),
  title text NOT NULL CHECK (char_length(title) <= 200),
  body text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('open','claimed','in_review','done','cancelled')),
  created_by_agent_id text NOT NULL,
  created_by_owner_id text NOT NULL,
  from_message_seq bigint,
  attachment_ids text[] NOT NULL DEFAULT '{}',
  claim_agent_id text,
  claim_owner_id text,
  claim_expires_at bigint,
  claim_ttl_ms integer,
  claim_grace_ms integer,
  claim_token_hash text,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  result jsonb,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE (room_id, number),
  UNIQUE (created_by_owner_id, idempotency_key),
  CHECK ((status = 'claimed') = (claim_agent_id IS NOT NULL)),
  CHECK ((claim_agent_id IS NULL) = (claim_token_hash IS NULL)),
  CHECK ((claim_agent_id IS NULL) = (claim_expires_at IS NULL))
);
CREATE INDEX IF NOT EXISTS room_tasks_claims ON room_tasks(claim_expires_at)
  WHERE claim_agent_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS room_task_events (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES room_tasks(id),
  action text NOT NULL CHECK (action IN ('created','claimed','renewed','released','lapsed')),
  generation bigint,
  actor text NOT NULL,
  agent_id text,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS room_task_events_task ON room_task_events(task_id, created_at);
`,
};

/**
 * Migration 30 `room_task_review_events` (results and lapse). The `result` column already exists (migration 24); this migration only widens the
 * `room_task_events` action CHECK for the review transitions and the stale-write
 * audit. The generated CHECK name is deterministic (`room_task_events_action_check`).
 */
export const roomTaskReviewEventsMigration: Migration = {
  version: 30,
  name: 'room_task_review_events',
  sql: `
ALTER TABLE room_task_events DROP CONSTRAINT IF EXISTS room_task_events_action_check;
ALTER TABLE room_task_events ADD CHECK (action IN
  ('created','claimed','renewed','released','lapsed','result_posted','approved','rejected','cancelled','stale_rejected'));
ALTER TABLE room_task_events ADD COLUMN IF NOT EXISTS details jsonb;
`,
};

/** Idempotent; call before runMigrations (after the room format migration). */
export function registerRoomTasksMigration(): void {
  registerMigration(roomTasksMigration);
  registerMigration(roomTaskReviewEventsMigration);
}
