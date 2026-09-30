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
