import { registerRoomInviteMigration } from './invite-schema.js';
import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 14 `join_links` (universal join link; docs/JOIN_LINKS.md).
 *
 * One short-lived, high-entropy code behind `/j/<code>` for a target: a room invite (bound to one
 * room link, so rotating or closing the room kills it) or "connect to Central City". Only the
 * code's SHA-256 is stored. `max_uses` bounds admissions for single-use room codes; reading the
 * link (GET, previews, unfurling) never counts.
 */
export const joinLinksMigration: Migration = {
  version: 14,
  name: 'join_links',
  sql: `
CREATE TABLE IF NOT EXISTS join_links (
  id text PRIMARY KEY, code_hash text NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES operators(id),
  target text NOT NULL CHECK (target IN ('room','connect')),
  room_id text, room_link_id text,
  created_at bigint NOT NULL, expires_at bigint NOT NULL,
  max_uses integer CHECK (max_uses IS NULL OR max_uses >= 1),
  uses integer NOT NULL DEFAULT 0, revoked_at bigint,
  CHECK ((target = 'room') = (room_id IS NOT NULL AND room_link_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS join_links_owner ON join_links(owner_id, created_at);
CREATE INDEX IF NOT EXISTS join_links_room ON join_links(room_id);
`,
};

/** Idempotent; call before runMigrations (after the rooms migration). */
export function registerJoinLinksMigration(): void {
  registerMigration(joinLinksMigration);
  registerRoomInviteMigration();
}
