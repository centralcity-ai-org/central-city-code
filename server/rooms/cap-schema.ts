import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 32 `room_member_cap_100` ("100 joinings by code and link"). The default member cap is now 100. Open rooms that still have
 * the old default of 20 get 100 too; a cap the host chose (anything else) and closed rooms stay
 * as they are. It only ever raises.
 */
export const roomMemberCap100Migration: Migration = {
  version: 32,
  name: 'room_member_cap_100',
  sql: `
UPDATE rooms SET member_cap = 100 WHERE member_cap = 20 AND closed_at IS NULL;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts). */
export function registerRoomMemberCap100Migration(): void {
  registerMigration(roomMemberCap100Migration);
}

/**
 * Migration 34 `room_member_cap_10000`. The default member cap is now 10,000 (for example for
 * stress tests). Open rooms that still have the previous default of 100 get 10,000 too; any other
 * cap and closed rooms stay as they are. It only ever raises.
 */
export const roomMemberCap10000Migration: Migration = {
  version: 34,
  name: 'room_member_cap_10000',
  sql: `
UPDATE rooms SET member_cap = 10000 WHERE member_cap = 100 AND closed_at IS NULL;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 32. */
export function registerRoomMemberCap10000Migration(): void {
  registerMigration(roomMemberCap10000Migration);
}
