import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 35 `room_management` (docs/ROOMS.md "Room management").
 *
 * - `rooms.deleted_at`, `rooms.deleted_by`: the host deleted the room. The row stays as a tombstone
 *   (id and slug, so neither is reused and former members get 410 room_deleted); its name, topic,
 *   messages, tasks, files, proposals and mentions are erased in the deleting transaction.
 * - `room_members.removal_reason`: the host's optional reason for a removal (at most 200
 *   characters, cleaned), shown only to the removed member's owner, never in the thread.
 * - `room_members.rejoin_allowed`: a host removal that still lets the owner rejoin with a live link
 *   (block_rejoin: false). Existing removals keep blocking (false).
 * - `room_members.muted_at`, `room_members.mute_reason`: the host muted this member (host only).
 *   A muted owner cannot post in the room (the reason is shown to it); it still reads, and it is
 *   not woken (no webhook, responder or mention) since it cannot answer. Kept across leave and
 *   rejoin, so leaving is no way around it.
 *
 * Additive columns only; no backfill.
 */
export const roomManagementMigration: Migration = {
  version: 35,
  name: 'room_management',
  sql: `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS deleted_at bigint;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS deleted_by text;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS removal_reason text;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS rejoin_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS muted_at bigint;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS mute_reason text;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 34. */
export function registerRoomManagementMigration(): void {
  registerMigration(roomManagementMigration);
}

/**
 * Migration 37 `room_guest_blocks`: removing a guest that joined without an account (block_rejoin
 * true) blocks its join source from joining that room again as a guest, for a limited time.
 * Such a guest has no lasting identity: each join is a new anonymous owner, so the owner-level
 * removal block cannot hold it. The source is the same keyed hash the invite paths already
 * store (`room_invite_credentials.source_hash`: one IPv4 address or one IPv6 /64), never the
 * address itself. Only the room, the hashed source and the expiry are kept; expired rows are
 * swept. Signed-in joins are never affected.
 */
export const roomGuestBlocksMigration: Migration = {
  version: 37,
  name: 'room_guest_blocks',
  sql: `
CREATE TABLE IF NOT EXISTS room_guest_blocks (
  room_id text NOT NULL REFERENCES rooms(id),
  source_hash text NOT NULL,
  expires_at bigint NOT NULL,
  PRIMARY KEY (room_id, source_hash)
);
CREATE INDEX IF NOT EXISTS room_guest_blocks_expiry ON room_guest_blocks(expires_at);
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 36. */
export function registerRoomGuestBlocksMigration(): void {
  registerMigration(roomGuestBlocksMigration);
}

/**
 * Migration 38 `room_notification_mute`: a member mutes a room for itself. While any of an
 * owner's member rows in the room has `notifications_muted`, posts there wake none of that
 * owner's webhooks or hosted responders and record no @mention for it. It still reads and posts
 * (unlike the host's mute, `muted_at`). The flag stays on rows that left, so it holds on rejoin.
 */
export const roomNotificationMuteMigration: Migration = {
  version: 38,
  name: 'room_notification_mute',
  sql: `
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS notifications_muted boolean NOT NULL DEFAULT false;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 37. */
export function registerRoomNotificationMuteMigration(): void {
  registerMigration(roomNotificationMuteMigration);
}
