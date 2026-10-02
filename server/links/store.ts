import { createHash } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import { normalizeShortCode, shortCodeHash } from './short-code.js';

/**
 * Join-link storage primitives shared by the links module and the rooms service (a join code can
 * stand in for a room invite token). Codes are 256-bit random values; only their SHA-256 is stored.
 */
export const codeHash = (code: string) =>
  createHash('sha256').update(`join-link:${code}`).digest('hex');

export type JoinLinkRow = {
  id: string;
  owner_id: string;
  target: 'room' | 'connect';
  room_id: string | null;
  room_link_id: string | null;
  created_at: string | number;
  expires_at: string | number;
  max_uses: number | null;
  uses: number;
  revoked_at: string | number | null;
};

/**
 * The live join link for a code, or null (unknown, expired, exhausted or revoked alike). A short
 * code (7K4M-Q9XP, any case or spacing) resolves to the join link it aliases.
 */
export async function liveJoinLink(
  q: Pick<Tx, 'query'>,
  code: string,
  time: number,
  lock = false,
): Promise<JoinLinkRow | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
    const short = normalizeShortCode(code);
    return short ? liveJoinLinkByShort(q, short, time, lock) : null;
  }
  const row = (
    await q.query<JoinLinkRow>(
      `SELECT * FROM join_links WHERE code_hash=$1${lock ? ' FOR UPDATE' : ''}`,
      [codeHash(code)],
    )
  ).rows[0];
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= time) return null;
  if (row.max_uses !== null && row.uses >= row.max_uses) return null;
  return row;
}

/** The live join link a short code aliases (normalized code), or null, like liveJoinLink. */
export async function liveJoinLinkByShort(
  q: Pick<Tx, 'query'>,
  code: string,
  time: number,
  lock = false,
): Promise<JoinLinkRow | null> {
  const row = (
    await q.query<JoinLinkRow>(
      `SELECT * FROM join_links WHERE short_hash=$1 ORDER BY created_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [shortCodeHash(code)],
    )
  ).rows[0];
  return live(row, time);
}

/** A live join link by id (re-checked under its row lock inside an admitting transaction). */
export async function liveJoinLinkById(
  q: Pick<Tx, 'query'>,
  id: string,
  time: number,
  lock = false,
): Promise<JoinLinkRow | null> {
  const row = (
    await q.query<JoinLinkRow>(`SELECT * FROM join_links WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [
      id,
    ])
  ).rows[0];
  return live(row, time);
}

function live(row: JoinLinkRow | undefined, time: number): JoinLinkRow | null {
  if (!row || row.revoked_at !== null || Number(row.expires_at) <= time) return null;
  if (row.max_uses !== null && row.uses >= row.max_uses) return null;
  return row;
}

/** Counts one admission through a join link (inside the admitting transaction, row locked). */
export async function consumeJoinLink(tx: Pick<Tx, 'query'>, id: string): Promise<void> {
  await tx.query('UPDATE join_links SET uses=uses+1 WHERE id=$1', [id]);
}

/** Revokes the join links pointing at a room (rotation and closing). */
export async function revokeRoomJoinLinks(
  tx: Pick<Tx, 'query'>,
  roomId: string,
  time: number,
  exceptRoomLinkId?: string,
): Promise<void> {
  await tx.query(
    `UPDATE join_links SET revoked_at=$2 WHERE room_id=$1 AND revoked_at IS NULL${exceptRoomLinkId ? ' AND room_link_id<>$3' : ''}`,
    exceptRoomLinkId ? [roomId, time, exceptRoomLinkId] : [roomId, time],
  );
}
