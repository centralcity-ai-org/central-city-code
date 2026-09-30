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

/**
 * Migration 36 `room_member_cap_standard_100` (standard rooms: at most 100
 * members; approved operators up to 10,000). Every open room with a cap above 100 gets 100, or its current number
 * of active members when that is higher: nobody is evicted, and such a room admits nobody new
 * until it is below its host's maximum. The runtime bounds joins by min(stored cap, host maximum)
 * anyway (rooms/service.ts hostMemberMax); this makes the stored caps say so.
 *
 * A migration cannot read CITY_STRESS_TEST_OPERATORS, so rooms of approved stress-test operators
 * are lowered too; those hosts may raise the cap again in the room settings (up to 10,000).
 * Closed rooms stay as they are.
 */
export const roomMemberCapStandard100Migration: Migration = {
  version: 36,
  name: 'room_member_cap_standard_100',
  sql: `
UPDATE rooms r SET member_cap = GREATEST(100, (
  SELECT count(*) FROM room_members m WHERE m.room_id = r.id AND m.removed_at IS NULL
))
WHERE r.member_cap > 100 AND r.closed_at IS NULL;
`,
  // What it changes, measured before the UPDATE: counts only (no room or host ids).
  report: {
    event: 'rooms.migration36',
    async measure(tx) {
      const row = (
        await tx.query<Record<string, string | number | null>>(
          `SELECT count(*) AS rooms_lowered,
                  count(*) FILTER (WHERE r.member_cap = 10000) AS at_10000,
                  count(*) FILTER (WHERE a.active > 100) AS over_100_active,
                  COALESCE(max(a.active), 0) AS largest_active
             FROM rooms r
             CROSS JOIN LATERAL (SELECT count(*) AS active FROM room_members m
                                  WHERE m.room_id = r.id AND m.removed_at IS NULL) a
            WHERE r.member_cap > 100 AND r.closed_at IS NULL`,
        )
      ).rows[0]!;
      return {
        rooms_lowered: Number(row.rooms_lowered),
        at_10000: Number(row.at_10000),
        over_100_active: Number(row.over_100_active),
        largest_active: Number(row.largest_active),
      };
    },
  },
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts) after migration 34. */
export function registerRoomMemberCapStandard100Migration(): void {
  registerMigration(roomMemberCapStandard100Migration);
}
