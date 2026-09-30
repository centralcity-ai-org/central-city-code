import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 12 `cross_connections` (cross-owner connections; docs/AI_WORKSPACES.md).
 *
 * - `cross_connections`: one row per directional request. At most one row per
 *   (from_agent_id, to_agent_id) is `pending` or `approved` (partial unique index), and a
 *   request's idempotency key is unique per requesting owner. Only `approved` authorizes messages
 *   and hosted demo jobs across owners. `from_owner_label` is the label the recipient saw.
 * - `cross_invites`: single-use, expiring, revocable invite tokens (stored hashed) for one agent.
 * - `cross_agent_settings`: an owner may stop a public agent accepting requests by id.
 * - `messages.origin` marks cross-owner messages `external`, with the sender's owner label.
 */
export const CROSS_CONNECTIONS_TABLE = `
CREATE TABLE IF NOT EXISTS cross_connections (
  id text PRIMARY KEY, from_agent_id text NOT NULL,
  from_owner_id text NOT NULL REFERENCES operators(id),
  to_agent_id text NOT NULL, to_owner_id text NOT NULL REFERENCES operators(id),
  status text NOT NULL CHECK (status IN ('pending','approved','denied','revoked','expired')),
  note text NOT NULL DEFAULT '', from_owner_label text NOT NULL,
  requested_at bigint NOT NULL, expires_at bigint NOT NULL,
  decided_at bigint, decided_by text, revoked_at bigint, revoked_by text,
  invite_id text, idempotency_key text NOT NULL, request_hash text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS cross_connections_live ON cross_connections(from_agent_id, to_agent_id) WHERE status IN ('pending','approved');
CREATE UNIQUE INDEX IF NOT EXISTS cross_connections_idempotency ON cross_connections(from_owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS cross_connections_from ON cross_connections(from_owner_id, status);
CREATE INDEX IF NOT EXISTS cross_connections_to ON cross_connections(to_owner_id, status);
CREATE INDEX IF NOT EXISTS cross_connections_target ON cross_connections(to_agent_id, status);
`;
export const crossConnectionsMigration: Migration = {
  version: 12,
  name: 'cross_connections',
  sql: `${CROSS_CONNECTIONS_TABLE}
CREATE TABLE IF NOT EXISTS cross_invites (
  id text PRIMARY KEY, token_hash text NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES operators(id), agent_id text NOT NULL,
  created_at bigint NOT NULL, expires_at bigint NOT NULL, used_at bigint, revoked_at bigint
);
CREATE INDEX IF NOT EXISTS cross_invites_owner ON cross_invites(owner_id);
CREATE TABLE IF NOT EXISTS cross_agent_settings (
  agent_id text PRIMARY KEY, owner_id text NOT NULL REFERENCES operators(id),
  requests_disabled boolean NOT NULL DEFAULT false
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal','external'));
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_owner_label text;
CREATE INDEX IF NOT EXISTS messages_sender_owner_created ON messages(sender_owner_id, created_at);
CREATE INDEX IF NOT EXISTS messages_context ON messages(context_id);
`,
};

/** Idempotent; call before runMigrations (after the messaging migration is registered). */
export function registerCrossConnectionsMigration(): void {
  registerMigration(crossConnectionsMigration);
}
