import { registerMigration, type Migration } from '../migrations.js';
import { registerMemberActivityMigration } from './member-status.js';
import { registerRoomPeopleMigration } from './person.js';
import { registerRoomSystemLinesMigration } from './system-lines.js';
import {
  registerRoomMemberCap100Migration,
  registerRoomMemberCap10000Migration,
} from './cap-schema.js';

/**
 * Migration 13 `rooms` (Rooms; the ROOMS-SEC-001 threat model; docs/ROOMS.md).
 *
 * - `rooms`: one shared thread. `next_seq` is the per-room sequence allocator (`UPDATE ... RETURNING`,
 *   like `inbox_cursors`), so room messages are gap-free and visible in commit order. The host is an
 *   owner (`host_owner_id`) acting through one of its agents (`host_agent_id`).
 * - `room_members`: membership of one agent (of any owner) in one room. It grants the room only,
 *   never the member's or the host's workspace. `visible_from_seq` is the server-assigned history
 *   start (messages with a greater seq are visible). Removal is a timestamp, never a delete.
 * - `room_messages`: sender id, owner and the display labels are stamped by the server at post time.
 * - `room_receipts`: post idempotency per (room, owner, key), bound to the request hash.
 * - `room_links`: invite links. The token is derived (HMAC under the server secret) from a random
 *   salt and only its SHA-256 is stored; `rotate_key` makes a rotation idempotent per room.
 * - `room_join_receipts`: join idempotency per (owner, key), bound to the request hash.
 * - `room_events`: append-only security audit with server-derived actor and action.
 */
export const ROOM_TABLES = [
  'room_events',
  'room_join_receipts',
  'room_links',
  'room_members',
  'room_messages',
  'room_receipts',
  'rooms',
] as const;

export const roomsMigration: Migration = {
  version: 13,
  name: 'rooms',
  sql: `
CREATE TABLE IF NOT EXISTS rooms (
  id text PRIMARY KEY, slug text NOT NULL UNIQUE,
  name text NOT NULL, topic text NOT NULL DEFAULT '',
  host_owner_id text NOT NULL REFERENCES operators(id), host_agent_id text NOT NULL,
  member_cap integer NOT NULL CHECK (member_cap >= 2),
  history text NOT NULL CHECK (history IN ('from_join','full')),
  link_ttl_ms bigint NOT NULL, link_max_uses integer,
  next_seq bigint NOT NULL DEFAULT 1 CHECK (next_seq >= 1),
  created_at bigint NOT NULL, closed_at bigint, closed_by text,
  idempotency_key text NOT NULL, request_hash text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rooms_idempotency ON rooms(host_owner_id, idempotency_key);
CREATE INDEX IF NOT EXISTS rooms_host ON rooms(host_owner_id, closed_at);
CREATE TABLE IF NOT EXISTS room_members (
  room_id text NOT NULL REFERENCES rooms(id), agent_id text NOT NULL,
  owner_id text NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('host','member','guest')),
  owner_label text NOT NULL, visible_from_seq bigint NOT NULL CHECK (visible_from_seq >= 0),
  joined_at bigint NOT NULL, joined_by text NOT NULL,
  removed_at bigint, removed_by text,
  PRIMARY KEY(room_id, agent_id)
);
CREATE INDEX IF NOT EXISTS room_members_owner ON room_members(owner_id, room_id);
CREATE TABLE IF NOT EXISTS room_messages (
  room_id text NOT NULL REFERENCES rooms(id), seq bigint NOT NULL, id uuid NOT NULL,
  sender_agent_id text NOT NULL, sender_owner_id text NOT NULL,
  sender_name text NOT NULL, sender_owner_label text NOT NULL,
  parts jsonb NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(room_id, seq)
);
CREATE TABLE IF NOT EXISTS room_receipts (
  room_id text NOT NULL, owner_id text NOT NULL, idempotency_key text NOT NULL,
  request_hash text NOT NULL, seq bigint NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(room_id, owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS room_links (
  id text PRIMARY KEY, room_id text NOT NULL REFERENCES rooms(id),
  salt text NOT NULL, token_hash text NOT NULL UNIQUE,
  created_at bigint NOT NULL, expires_at bigint NOT NULL,
  max_uses integer, uses integer NOT NULL DEFAULT 0, revoked_at bigint,
  created_by text NOT NULL, rotate_key text
);
CREATE UNIQUE INDEX IF NOT EXISTS room_links_rotation ON room_links(room_id, rotate_key);
CREATE INDEX IF NOT EXISTS room_links_room ON room_links(room_id, created_at);
CREATE TABLE IF NOT EXISTS room_join_receipts (
  owner_id text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL,
  room_id text NOT NULL, agent_id text NOT NULL, created_agent boolean NOT NULL,
  joined boolean NOT NULL, created_at bigint NOT NULL,
  PRIMARY KEY(owner_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS room_events (
  id text PRIMARY KEY, room_id text NOT NULL, actor_owner_id text NOT NULL, actor text NOT NULL,
  action text NOT NULL, agent_id text, created_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS room_events_room ON room_events(room_id, created_at);
`,
};

/** Idempotent; call before runMigrations (after the cross-connections migration). */
export function registerRoomsMigration(): void {
  registerMigration(roomsMigration);
  // 21: room_members.last_read_seq (read cursor) and last_active_at (member status),
  // server/rooms/member-status.ts.
  registerMemberActivityMigration();
  // 31: people in rooms (kind, display name, host toggles) and short join codes (person.ts).
  registerRoomPeopleMigration();
  // 32: member cap 100 for open rooms still at the old default of 20 (cap-schema.ts).
  registerRoomMemberCap100Migration();
  // 33: server-written system lines in the thread (sender_kind 'system', system-lines.ts).
  registerRoomSystemLinesMigration();
  // 34: member cap 10,000 for open rooms still at the previous default of 100 (cap-schema.ts).
  registerRoomMemberCap10000Migration();
}
