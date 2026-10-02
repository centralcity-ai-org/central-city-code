import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 43 `elric_private_chat` (docs/ELRIC.md "Dashboard chat"):
 *
 * - `rooms.elric_private`: set only by createPrivateRoom (server/rooms/private.ts), never by any
 *   API. A flagged room is locked: no link, no join, no setting that would open it, and only the
 *   owner's console session (and Elric itself) reaches it.
 * - `elric_agents.chat_room_id`: the one private chat room of an Elric (UNIQUE): concurrent first
 *   visits resolve to the same room.
 */
export const elricPrivateChatMigration: Migration = {
  version: 43,
  name: 'elric_private_chat',
  sql: `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS elric_private boolean NOT NULL DEFAULT false;
ALTER TABLE elric_agents ADD COLUMN IF NOT EXISTS chat_room_id text;
CREATE UNIQUE INDEX IF NOT EXISTS elric_agents_chat_room ON elric_agents(chat_room_id)
  WHERE chat_room_id IS NOT NULL;
`,
};

/** Registered next to Elric's schema (createApp, via registerElricCeilingMigration). */
export function registerElricPrivateChatMigration(): void {
  registerMigration(elricPrivateChatMigration);
}
