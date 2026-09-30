import type { Transaction as Tx } from '../database.js';
import type { MessagePart } from '../messaging/contract.js';
import { WAKE_LIMITS } from './contract.js';
import { excerptAt, findMentions, textOf } from './mentions.js';
import { emit, type WakeSignal } from './signals.js';

/**
 * In-transaction wake hooks (docs/WAKE.md), called by the messaging and rooms services
 * right after they write a new message, inside the same transaction:
 *
 * 1. record @mentions of agents that can already read the message (never anyone else);
 * 2. coalesce a pending webhook wake-up into `wake_outbox` for affected agents' webhooks;
 * 3. emit after-commit signals so in-process waiters wake at once.
 *
 * No rate limiter, network call or second pool client is used here. Locks: only the mentioned
 * agents' `wake_cursors` rows (taken in sorted id order) and their `wake_outbox` rows.
 */

interface MentionRow {
  agentId: string;
  ownerId: string;
  sourceKind: 'message' | 'room';
  sourceId: string;
  roomId: string | null;
  sourceSeq: number;
  contextId: string | null;
  fromAgentId: string;
  fromName: string;
  fromOwnerLabel: string | null;
  excerpt: string;
  time: number;
}

/**
 * Allocates the next mention seq and writes the row; null when the agent's backlog is full. The
 * backlog counts unread mentions (`unread_count`, migration 26), not the cursor span, so mentions
 * nobody acknowledges below the cursor cannot stop recording.
 */
async function insertMention(tx: Tx, row: MentionRow): Promise<number | null> {
  await tx.query(
    'INSERT INTO wake_cursors(agent_id,next_mention_seq,acked_mention_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
    [row.agentId, row.time],
  );
  const allocated = (
    await tx.query<{ seq: number | string }>(
      `UPDATE wake_cursors SET next_mention_seq=next_mention_seq+1, unread_count=unread_count+1, updated_at=$2
       WHERE agent_id=$1 AND unread_count < $3 RETURNING next_mention_seq-1 AS seq`,
      [row.agentId, row.time, WAKE_LIMITS.unreadMentions],
    )
  ).rows[0];
  if (!allocated) return null;
  const seq = Number(allocated.seq);
  await tx.query(
    `INSERT INTO mentions(agent_id,seq,owner_id,source_kind,source_id,room_id,source_seq,context_id,from_agent_id,from_name,from_owner_label,excerpt,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      row.agentId,
      seq,
      row.ownerId,
      row.sourceKind,
      row.sourceId,
      row.roomId,
      row.sourceSeq,
      row.contextId,
      row.fromAgentId,
      row.fromName.slice(0, 200),
      row.fromOwnerLabel,
      row.excerpt,
      row.time,
    ],
  );
  return seq;
}

/** Coalesces into the pending wake-up of every enabled webhook the statement selects. */
const UPSERT = `ON CONFLICT (webhook_id) DO UPDATE SET
  kinds = ARRAY(SELECT DISTINCT e FROM unnest(wake_outbox.kinds || EXCLUDED.kinds) AS e ORDER BY e),
  event = EXCLUDED.event, pending = wake_outbox.pending + 1, version = wake_outbox.version + 1
  RETURNING webhook_id`;

/** Direct message delivered into `recipientId`'s inbox (server/messaging/service.ts send). */
export async function messageDelivered(
  tx: Tx,
  m: {
    recipientId: string;
    recipientName: string;
    recipientOwnerId: string;
    senderId: string;
    senderName: string;
    senderOwnerLabel: string | null;
    messageId: string;
    seq: number;
    contextId: string;
    parts: MessagePart[];
    time: number;
  },
): Promise<void> {
  const signals: WakeSignal[] = [{ kind: 'inbox', id: m.recipientId, seq: m.seq }];
  const kinds = ['message'];
  const text = textOf(m.parts);
  if (text.includes('@')) {
    // Only the recipient can read a direct message, so only the recipient can be mentioned.
    const found = findMentions(
      text,
      [
        { id: m.recipientId, name: m.recipientName },
        { id: m.senderId, name: m.senderName },
      ],
      { exclude: m.senderId },
    );
    if (found.ids.length) {
      const seq = await insertMention(tx, {
        agentId: m.recipientId,
        ownerId: m.recipientOwnerId,
        sourceKind: 'message',
        sourceId: m.messageId,
        roomId: null,
        sourceSeq: m.seq,
        contextId: m.contextId,
        fromAgentId: m.senderId,
        fromName: m.senderName,
        fromOwnerLabel: m.senderOwnerLabel,
        excerpt: excerptAt(text, found.offsets.get(m.recipientId) ?? 0),
        time: m.time,
      });
      if (seq !== null) {
        signals.push({ kind: 'mention', id: m.recipientId, seq });
        kinds.push('mention');
      }
    }
  }
  const event = {
    kind: 'message',
    message_id: m.messageId,
    seq: m.seq,
    context_id: m.contextId,
    from_agent_id: m.senderId,
  };
  const queued = await tx.query(
    `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
     SELECT w.id, w.agent_id, k.kinds, $3::jsonb, 1, 1, 0, $4, $4, w.kind FROM wake_webhooks w
     CROSS JOIN LATERAL (SELECT ARRAY(SELECT e FROM unnest($2::text[]) AS e WHERE e = ANY(w.events) ORDER BY e) AS kinds) k
     -- Direct messages wake HTTPS webhooks only; hosted responders answer room mentions.
     WHERE w.agent_id=$1 AND w.kind='https' AND w.disabled_at IS NULL AND cardinality(k.kinds) > 0 ORDER BY w.id
     ${UPSERT}`,
    [m.recipientId, kinds, JSON.stringify(event), m.time],
  );
  if (queued.rows.length) signals.push({ kind: 'outbox' });
  emit(tx, ...signals);
}

/** New room post (server/rooms/service.ts post), with the inserted room_messages row. */
export async function roomPosted(
  tx: Tx,
  row: {
    room_id: string;
    seq: string | number;
    id: string;
    sender_agent_id: string;
    sender_name: string;
    sender_owner_label: string;
    parts: MessagePart[];
    created_at: string | number;
    /** Server-stamped auto-reply label (migration 26); an auto-reply wakes no responder. */
    auto_reply?: unknown;
  },
): Promise<void> {
  const seq = Number(row.seq);
  const time = Number(row.created_at);
  const signals: WakeSignal[] = [{ kind: 'room', id: row.room_id, seq }];
  const text = textOf(row.parts);
  const mentioned: string[] = [];
  if (text.includes('@')) {
    // Candidates: active members that can read this post: live agents of their owners, and
    // people in the room by their room-unique display name (migration 31). A member whose owner
    // the host muted (migration 35), or who muted the room's notifications for itself (migration
    // 38), still counts as a name (so "@Ann Lee" never falls back to "@Ann"), but no mention is
    // recorded for it.
    const members = (
      await tx.query<{
        agent_id: string;
        owner_id: string;
        name: string;
        kind: string;
        muted: boolean;
      }>(
        `SELECT m.agent_id, m.owner_id, a->>'name' AS name, 'agent' AS kind,
            EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
              AND x.room_id=m.room_id AND (x.muted_at IS NOT NULL OR x.notifications_muted)) AS muted FROM room_members m
          JOIN workspaces w ON w.operator_id=m.owner_id
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.kind='agent' AND a->>'id'=m.agent_id AND (a->>'revokedAt') IS NULL
         UNION ALL
         SELECT m.agent_id, m.owner_id, m.display_name AS name, 'person' AS kind,
            EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
              AND x.room_id=m.room_id AND (x.muted_at IS NOT NULL OR x.notifications_muted)) AS muted FROM room_members m
          WHERE m.room_id=$1 AND m.removed_at IS NULL AND m.visible_from_seq < $2
            AND m.kind='person' AND m.display_name IS NOT NULL`,
        [row.room_id, seq],
      )
    ).rows;
    const found = findMentions(
      text,
      members.map((member) => ({ id: member.agent_id, name: member.name })),
      { exclude: row.sender_agent_id },
    );
    const owners = new Map(members.map((member) => [member.agent_id, member.owner_id]));
    const muted = new Set(members.filter((member) => member.muted).map((m) => m.agent_id));
    // Sorted, so concurrent posts lock wake_cursors rows in one global order.
    for (const agentId of [...found.ids].sort()) {
      if (muted.has(agentId)) continue;
      const mentionSeq = await insertMention(tx, {
        agentId,
        ownerId: owners.get(agentId)!,
        sourceKind: 'room',
        sourceId: row.id,
        roomId: row.room_id,
        sourceSeq: seq,
        contextId: null,
        fromAgentId: row.sender_agent_id,
        fromName: row.sender_name,
        fromOwnerLabel: row.sender_owner_label,
        excerpt: excerptAt(text, found.offsets.get(agentId) ?? 0),
        time,
      });
      if (mentionSeq !== null) {
        mentioned.push(agentId);
        signals.push({ kind: 'mention', id: agentId, seq: mentionSeq });
      }
    }
  }
  const event = {
    kind: 'room_post',
    room_id: row.room_id,
    message_id: row.id,
    seq,
    from_agent_id: row.sender_agent_id,
  };
  const queued = await tx.query(
    `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
     SELECT w.id, w.agent_id, k.kinds, $3::jsonb, 1, 1, 0, $4, $4, w.kind FROM wake_webhooks w
     JOIN room_members m ON m.agent_id=w.agent_id AND m.room_id=$1 AND m.removed_at IS NULL
       AND m.kind='agent'
       -- The host muted this owner here (migration 35): it cannot answer, so it is not woken
       -- (a hosted responder would spend the member's tokens on a refused reply). Or the owner
       -- muted the room's notifications for itself (migration 38): no wake-up either.
       AND NOT EXISTS (SELECT 1 FROM room_members x WHERE x.owner_id=m.owner_id
         AND x.room_id=m.room_id AND (x.muted_at IS NOT NULL OR x.notifications_muted))
     CROSS JOIN LATERAL (SELECT ARRAY(SELECT e FROM unnest(
       CASE WHEN w.agent_id = ANY($2::text[]) THEN ARRAY['room_post','mention'] ELSE ARRAY['room_post'] END
     ) AS e WHERE e = ANY(w.events) ORDER BY e) AS kinds) k
     WHERE w.disabled_at IS NULL AND w.agent_id <> $5 AND cardinality(k.kinds) > 0
       -- A hosted responder (events ['mention']) is woken only by a mention in a room whose
       -- host allows responders, and never by an auto-reply (loop protection, review B7/N10).
       AND (w.kind = 'https' OR ($6::boolean AND EXISTS (
         SELECT 1 FROM rooms r WHERE r.id=$1 AND r.responders_allowed AND r.closed_at IS NULL)))
     ORDER BY w.id
     ${UPSERT}`,
    [
      row.room_id,
      mentioned,
      JSON.stringify(event),
      time,
      row.sender_agent_id,
      row.auto_reply === undefined || row.auto_reply === null,
    ],
  );
  if (queued.rows.length) signals.push({ kind: 'outbox' });
  emit(tx, ...signals);
}
