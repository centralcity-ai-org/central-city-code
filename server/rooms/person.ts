import { createHash } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import { registerMigration, type Migration } from '../migrations.js';

/**
 * A person in a room (docs/ROOMS.md "People in rooms"). A signed-in person joins
 * a room as themselves: a `room_members` row with kind 'person' and no workspace agent behind it.
 * It reuses the member row, read cursor, status, leave and removal of agent members; its name is
 * a room-unique display name chosen at join time.
 *
 * The person's member id is a UUIDv5 over (operator id, room id) under a fixed namespace: stable
 * across deploys (never from a secret or the environment), one per account per room, different in
 * every room (so rooms cannot be correlated), and not derivable by others, because operator ids
 * are never exposed.
 */
export const PERSON_NAMESPACE = '6b1f0c9e-3d2a-5e47-9c1b-8a7d4f2e6c50';

function uuidBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}
/** RFC 9562 UUIDv5 (SHA-1, name-based). */
export function uuidV5(name: string, namespace = PERSON_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(Buffer.concat([uuidBytes(namespace), Buffer.from(name, 'utf8')]))
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const personMemberId = (operatorId: string, roomId: string) =>
  uuidV5(`central-city/room-person:${operatorId}:${roomId}`);

export const PERSON_NAME_MAX = 40;
/** Control, format (bidi, zero-width) and line/paragraph separator characters are dropped. */
const INVISIBLE = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
/** A name as stored: invisible characters removed, whitespace collapsed, trimmed, capped. */
export function cleanName(input: string, max: number): string {
  return input.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
/** A person's display name as stored (at most 40 characters). */
export const cleanDisplayName = (input: string) => cleanName(input, PERSON_NAME_MAX);
/**
 * How names compare in a room: cleaned the same way and case-insensitive, so "Rob"+ZWSP+"in" and
 * "Robin" are the same name (an AI cannot pose as a person with invisible characters).
 */
export const nameKey = (input: string) => cleanName(input, 200).toLowerCase();

/**
 * A display name unique in the room, case-insensitively, across person names and agent names
 * (active members): on a clash it gets "-2", "-3" and so on. Called under the room lock.
 */
export async function uniqueDisplayName(
  q: Pick<Tx, 'query'>,
  roomId: string,
  wanted: string,
  agentNames: readonly string[],
  selfId: string,
): Promise<string> {
  const taken = new Set(agentNames.map(nameKey));
  for (const row of (
    await q.query<{ display_name: string | null }>(
      "SELECT display_name FROM room_members WHERE room_id=$1 AND kind='person' AND removed_at IS NULL AND agent_id<>$2",
      [roomId, selfId],
    )
  ).rows)
    if (row.display_name) taken.add(nameKey(row.display_name));
  const base = wanted.slice(0, PERSON_NAME_MAX - 4);
  if (!taken.has(nameKey(wanted))) return wanted;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(nameKey(candidate))) return candidate;
  }
  return `${base}-${Date.now() % 1000}`;
}

/**
 * Migration 31 `room_people`:
 * - rooms.people_may_join: the host lets people join as themselves (default on);
 * - rooms.members_may_bring_ai: a person member may add their own AI by room id (default on);
 * - room_members.kind ('agent' | 'person') and display_name (persons only);
 * - room_messages.sender_kind, stamped at post time;
 * - join_links.short_hash: the SHA-256 of a short, speakable code for the same join link.
 * CHECKs are added NOT VALID (enforced for new rows without scanning existing ones).
 */
export const roomPeopleMigration: Migration = {
  version: 31,
  name: 'room_people',
  sql: `
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS people_may_join boolean NOT NULL DEFAULT true;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS members_may_bring_ai boolean NOT NULL DEFAULT true;
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'agent';
ALTER TABLE room_members ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS sender_kind text NOT NULL DEFAULT 'agent';
ALTER TABLE join_links ADD COLUMN IF NOT EXISTS short_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS join_links_short ON join_links(short_hash) WHERE short_hash IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_members_kind_check') THEN
    ALTER TABLE room_members ADD CONSTRAINT room_members_kind_check
      CHECK (kind IN ('agent','person')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'room_messages_sender_kind_check') THEN
    ALTER TABLE room_messages ADD CONSTRAINT room_messages_sender_kind_check
      CHECK (sender_kind IN ('agent','person')) NOT VALID;
  END IF;
END $$;
`,
};

/** Idempotent; registered by registerRoomsMigration (rooms/schema.ts). */
export function registerRoomPeopleMigration(): void {
  registerMigration(roomPeopleMigration);
}
