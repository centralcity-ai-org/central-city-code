import { registerMigration, type Migration } from '../../migrations.js';

/**
 * Migration 23 (room repositories): `room_workspaces_code` (docs/ROOM_REPOS.md).
 *
 * The whole schema for code in rooms lands at once, so later features (room files, line comments,
 * webhooks) need no new migration number. The current version uses: `github_installations`, `room_repo_bindings`,
 * `room_proposals`, `room_proposal_revisions`, `room_reviews`, `room_evidence`,
 * `room_code_settings` and `room_messages.ref`.
 *
 * - Additive only; every statement is `IF NOT EXISTS`. `room_messages.ref` is the same statement
 *   as in the step-1 attachments migration (27), so the two land in either order.
 * - `ref` is a server-stamped object reference (`{kind, id, number}`); clients never set it.
 * - Proposals, reviews and evidence are room state, visible to all current members (§2.4).
 * - `room_members.can_apply` defaults to false; in this version only the host applies.
 * - `github_webhook_deliveries` stores `X-GitHub-Delivery` ids for 24 h replay protection
 *.
 * - Recognized by recovery and never exported, like the rest of rooms.
 */
export const roomCodeMigration: Migration = {
  version: 23,
  name: 'room_workspaces_code',
  sql: `
CREATE TABLE IF NOT EXISTS github_installations (
  installation_id bigint PRIMARY KEY,
  owner_id text NOT NULL REFERENCES operators(id),
  account_login text NOT NULL,
  created_at bigint NOT NULL,
  revoked_at bigint
);
CREATE TABLE IF NOT EXISTS room_repo_bindings (
  room_id text PRIMARY KEY REFERENCES rooms(id),
  installation_id bigint NOT NULL REFERENCES github_installations(installation_id),
  repo_id bigint NOT NULL,
  repo_full_name text NOT NULL CHECK (char_length(repo_full_name) <= 140),
  default_branch text NOT NULL CHECK (char_length(default_branch) <= 255),
  private boolean NOT NULL DEFAULT true,
  bound_by text NOT NULL,
  bound_at bigint NOT NULL,
  unbound_at bigint,
  unbound_by text,
  status text NOT NULL CHECK (status IN ('active','revoked'))
);
CREATE INDEX IF NOT EXISTS room_repo_bindings_installation ON room_repo_bindings(installation_id);
CREATE TABLE IF NOT EXISTS room_files (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  path text NOT NULL CHECK (char_length(path) <= 300),
  current_rev integer NOT NULL,
  created_at bigint NOT NULL,
  deleted_at bigint,
  deleted_by text,
  UNIQUE (room_id, path)
);
CREATE TABLE IF NOT EXISTS room_file_versions (
  file_id text NOT NULL REFERENCES room_files(id),
  rev integer NOT NULL,
  content text NOT NULL CHECK (octet_length(content) <= 262144),
  sha256 text NOT NULL,
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  proposal_id text,
  message_seq bigint,
  created_at bigint NOT NULL,
  PRIMARY KEY (file_id, rev)
);
CREATE TABLE IF NOT EXISTS room_proposals (
  id text PRIMARY KEY,
  room_id text NOT NULL REFERENCES rooms(id),
  number integer NOT NULL CHECK (number >= 1),
  target text NOT NULL CHECK (target IN ('repo','room_file')),
  base jsonb NOT NULL,
  diff text NOT NULL CHECK (octet_length(diff) <= 262144),
  diff_sha256 text NOT NULL,
  files text[] NOT NULL,
  summary text NOT NULL CHECK (char_length(summary) <= 300),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  task_id text,
  supersedes text,
  status text NOT NULL CHECK (status IN
    ('open','out_of_date','conflict','applied','withdrawn','superseded','merged','closed')),
  base_behind_by integer,
  applied jsonb,
  message_seq bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  UNIQUE (room_id, number),
  UNIQUE (author_owner_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS room_proposals_room ON room_proposals(room_id, status, number);
CREATE TABLE IF NOT EXISTS room_proposal_revisions (
  proposal_id text NOT NULL REFERENCES room_proposals(id),
  revision integer NOT NULL,
  base jsonb NOT NULL,
  diff text NOT NULL,
  diff_sha256 text NOT NULL,
  files text[] NOT NULL,
  reason text NOT NULL CHECK (reason IN ('created','updated','rebased')),
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (proposal_id, revision)
);
CREATE TABLE IF NOT EXISTS room_reviews (
  id text PRIMARY KEY,
  proposal_id text NOT NULL REFERENCES room_proposals(id),
  proposal_revision integer NOT NULL,
  diff_sha256 text NOT NULL,
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('comment','approve','request_changes')),
  body text NOT NULL DEFAULT '' CHECK (char_length(body) <= 8000),
  message_seq bigint,
  created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS room_reviews_proposal ON room_reviews(proposal_id, proposal_revision, created_at);
CREATE TABLE IF NOT EXISTS room_comments (
  id text PRIMARY KEY,
  review_id text REFERENCES room_reviews(id),
  proposal_id text,
  file_id text,
  path text NOT NULL,
  side text NOT NULL CHECK (side IN ('old','new')),
  line integer NOT NULL,
  anchor_hash text NOT NULL,
  body text NOT NULL CHECK (char_length(body) <= 8000),
  author_agent_id text NOT NULL,
  author_owner_id text NOT NULL,
  created_at bigint NOT NULL,
  resolved_at bigint,
  resolved_by text
);
CREATE INDEX IF NOT EXISTS room_comments_proposal ON room_comments(proposal_id, created_at);
CREATE TABLE IF NOT EXISTS room_evidence (
  proposal_id text NOT NULL REFERENCES room_proposals(id),
  revision integer NOT NULL,
  head_sha text NOT NULL,
  checks jsonb NOT NULL,
  required text[] NOT NULL,
  state text NOT NULL CHECK (state IN ('retrieved','required_passed','required_failed','required_pending')),
  read_at bigint NOT NULL,
  PRIMARY KEY (proposal_id, revision, head_sha)
);
CREATE TABLE IF NOT EXISTS room_code_settings (
  room_id text PRIMARY KEY REFERENCES rooms(id),
  required_checks text[],
  min_approvals integer NOT NULL DEFAULT 1 CHECK (min_approvals BETWEEN 1 AND 5)
);
CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
  delivery_id text PRIMARY KEY,
  received_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS github_webhook_deliveries_received ON github_webhook_deliveries(received_at);
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS can_apply boolean NOT NULL DEFAULT false;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS ref jsonb;
`,
};

/** Every table migration 23 creates (recovery recognizes them; none is exported). */
export const ROOM_CODE_TABLES = [
  'github_installations',
  'github_webhook_deliveries',
  'room_code_settings',
  'room_comments',
  'room_evidence',
  'room_file_versions',
  'room_files',
  'room_proposal_revisions',
  'room_proposals',
  'room_repo_bindings',
  'room_reviews',
] as const;

/** Idempotent; call before runMigrations (after the rooms migration). */
export function registerRoomCodeMigration(): void {
  registerMigration(roomCodeMigration);
}
