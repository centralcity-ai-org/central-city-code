import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 22 `room_messages_format` (docs/ROOMS.md; format only, split from the attachments
 * migration 27).
 *
 * `room_messages.format` is `'plain' | 'markdown'` and server-stamped. Every existing row is
 * `'plain'`. The column default stays `'plain'` so any insert that does not name the column keeps
 * today's meaning; the rooms post path sets the new-post default (`'markdown'`) explicitly.
 *
 * Cost on a large table, all inside the migration transaction:
 * - `ADD COLUMN ... NOT NULL DEFAULT 'plain'` is metadata-only (PostgreSQL 11+): the constant is
 *   stored once as the attribute's missing value, with no table rewrite. NOT NULL costs nothing
 *   extra because the default fills every existing row.
 * - The CHECK is added `NOT VALID`, so it is enforced for every insert and update from now on but
 *   does not scan existing rows. An inline CHECK (or a `VALIDATE CONSTRAINT` in this same
 *   transaction) would scan the whole table while `ADD COLUMN` holds ACCESS EXCLUSIVE. Existing
 *   rows can only hold the constant `'plain'`, which satisfies the check by construction; a later
 *   `VALIDATE CONSTRAINT` (SHARE UPDATE EXCLUSIVE, no write block) is optional.
 * - The DO block keeps the migration safe on a database that already has the constraint.
 */
export const roomFormatMigration: Migration = {
  version: 22,
  name: 'room_messages_format',
  sql: `
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS format text NOT NULL DEFAULT 'plain';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'room_messages'::regclass AND conname = 'room_messages_format_check'
  ) THEN
    ALTER TABLE room_messages ADD CONSTRAINT room_messages_format_check
      CHECK (format IN ('plain','markdown')) NOT VALID;
  END IF;
END;
$$;
`,
};

/** Idempotent; call before runMigrations (after the rooms migration). */
export function registerRoomFormatMigration(): void {
  registerMigration(roomFormatMigration);
}
