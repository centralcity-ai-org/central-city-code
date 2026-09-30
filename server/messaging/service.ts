import { createHash, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { hasPermission, iso, type StoredAgent, type Workspace } from '../model.js';
import { messageDelivered } from '../wake/hooks.js';
import {
  MESSAGE_LIMITS,
  type AgentMessage,
  type ConversationSummary,
  type InboxAck,
  type InboxPage,
  type InboxSummary,
  type MessagePart,
} from './contract.js';

/**
 * Agent messaging v0 (docs/MESSAGING.md). Every operation runs in one short transaction that
 * never locks the owner's workspace row: the workspace document is read with a plain MVCC
 * snapshot (agents, pause state, connections), and the only rows locked are the recipient's
 * inbox cursor (sequence allocation) and the sender's idempotency receipt.
 */

/** Error with an HTTP status and a stable machine-readable code (surfaced as `code`). */
export class MessagingError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}
const fail = (status: number, code: string, message: string, retryAfterMs?: number): never => {
  throw new MessagingError(status, code, message, retryAfterMs);
};

/** Who is acting. `runtimeCredentialHash` binds a runtime caller to its current credential. */
export interface MessagingPrincipal {
  operatorId: string;
  runtime?: { agentId: string; credentialHash: string };
}
/** Extra authority check run first inside the operation's transaction (e.g. the current grant). */
export type Guard = (tx: Tx, time: number) => Promise<void>;
export interface SendInput {
  to_agent_id: string;
  text?: string;
  parts?: MessagePart[];
  context_id?: string;
  reply_to?: string;
  idempotency_key: string;
}
export interface InboxQuery {
  since?: number;
  before?: number;
  limit?: number;
  /** Without since/before: 'acked' continues after the acknowledged seq, 'latest' shows the newest page. */
  start: 'acked' | 'latest';
}
export interface MessagingDependencies {
  db: Database;
  clock: () => number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  inboxDepth?: number;
  sendsPerMinute?: number;
  /** Cross-owner sends per (sender, recipient) pair per minute (F4 §5; default 30). */
  crossPairPerMinute?: number;
  /** Inbound cross-owner sends per recipient owner per minute (F4 §5; default 600). */
  crossInboundPerMinute?: number;
}
export interface Messaging {
  send(
    principal: MessagingPrincipal,
    senderId: string,
    input: SendInput,
    guard?: Guard,
  ): Promise<{ message: AgentMessage }>;
  readInbox(
    principal: MessagingPrincipal,
    agentId: string,
    query: InboxQuery,
    guard?: Guard,
  ): Promise<InboxPage>;
  ack(
    principal: MessagingPrincipal,
    agentId: string,
    seq: number,
    guard?: Guard,
  ): Promise<InboxAck>;
  summary(operatorId: string): Promise<{ inboxes: InboxSummary[] }>;
  conversations(
    operatorId: string,
    limit?: number,
  ): Promise<{ conversations: ConversationSummary[] }>;
  conversation(
    operatorId: string,
    contextId: string,
    options?: { before?: string; limit?: number },
  ): Promise<{
    context_id: string;
    messages: AgentMessage[];
    has_more: boolean;
    next_before: string | null;
  }>;
}

type MessageRow = {
  /** 'external' for cross-owner messages (F4); absent on rows written before migration 12. */
  origin?: 'internal' | 'external';
  sender_owner_label?: string | null;
  recipient_id: string;
  seq: number | string;
  id: string;
  sender_id: string;
  context_id: string;
  reply_to: string | null;
  kind: 'message';
  parts: MessagePart[];
  created_at: number | string;
};
const COLUMNS =
  'recipient_id,seq,id,sender_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/**
 * The two agents of a pair in a fixed order, the key of their stored default conversation
 * (`pair_contexts`, migration 19). The default id itself is random: it cannot be derived from the
 * public agent ids, so no one outside the pair can name, probe or pre-claim it.
 */
export function pairKey(first: string, second: string): [string, string] {
  return first < second ? [first, second] : [second, first];
}
/** Latest messages of each inbox searched for the pair's current conversation (a bounded PK range). */
const PAIR_LOOKBACK = 1000;

/**
 * The id #61 (reverted) gave a pair's default conversation: an RFC 4122 version 5 UUID over the
 * sorted public agent ids, which anyone could compute. It is never issued any more. It is only
 * recognized, so that an agent that remembered it lands in its pair's stored conversation instead
 * of recreating a thread under it, and so scripts/remediate-pair-contexts.ts can find old rows.
 */
const LEGACY_PAIR_NAMESPACE = 'b6f1c1e2-3d4a-5b6c-8d9e-0f1a2b3c4d5e';
export function legacyPairContextId(first: string, second: string): string {
  const [low, high] = pairKey(first, second);
  const bytes = createHash('sha1')
    .update(Buffer.from(LEGACY_PAIR_NAMESPACE.replace(/-/g, ''), 'hex'))
    .update(`agent-pair:${low}:${high}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createMessaging(d: MessagingDependencies): Messaging {
  const depth = d.inboxDepth ?? MESSAGE_LIMITS.inboxDepth;
  const perMinute = d.sendsPerMinute ?? MESSAGE_LIMITS.sendsPerMinute;
  const crossPair = d.crossPairPerMinute ?? 30;
  const crossInbound = d.crossInboundPerMinute ?? 600;

  /** Unlocked snapshot read: never holds the owner's workspace row lock. */
  async function workspaceOf(tx: Tx, operatorId: string): Promise<Workspace> {
    const row = (
      await tx.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0];
    if (!row) fail(401, 'unauthorized', 'Sign in to continue.');
    return row!.data;
  }
  async function runtimeCurrent(tx: Tx, principal: MessagingPrincipal): Promise<void> {
    if (!principal.runtime) return;
    const current = await tx.query(
      'SELECT agent_id FROM credentials WHERE agent_id=$1 AND operator_id=$2 AND token_hash=$3',
      [principal.runtime.agentId, principal.operatorId, principal.runtime.credentialHash],
    );
    if (!current.rows.length) fail(401, 'unauthorized', 'Invalid runtime credential.');
  }
  function ownAgent(workspace: Workspace, id: string, role: string): StoredAgent {
    return (
      workspace.agents.find((agent) => agent.id === id) ??
      fail(404, 'agent_not_found', `${role} agent not found in this workspace.`)
    );
  }
  function project(row: MessageRow, names: Map<string, string>): AgentMessage {
    const external = row.origin === 'external';
    return {
      origin: external ? 'external' : 'internal',
      from_owner_label: external ? (row.sender_owner_label ?? null) : null,
      id: row.id,
      seq: Number(row.seq),
      kind: 'message',
      from_agent_id: row.sender_id,
      from_agent_name: names.get(row.sender_id) ?? 'Unknown agent',
      to_agent_id: row.recipient_id,
      to_agent_name: names.get(row.recipient_id) ?? 'Unknown agent',
      context_id: row.context_id,
      reply_to: row.reply_to,
      parts: row.parts,
      created_at: iso(Number(row.created_at)),
    };
  }
  const namesOf = (workspace: Workspace) =>
    new Map(workspace.agents.map((agent) => [agent.id, agent.name]));
  /**
   * Names for projection: this workspace's agents, plus peers in other workspaces that this one
   * is (or was) connected with by an accepted cross-workspace connection. Never other agents.
   */
  async function namesFor(
    tx: Tx,
    operatorId: string,
    workspace: Workspace,
    ids: Iterable<string>,
  ): Promise<Map<string, string>> {
    const names = namesOf(workspace);
    const missing = [...new Set(ids)].filter((id) => !names.has(id));
    if (!missing.length) return names;
    const rows = (
      await tx.query<{ id: string; name: string }>(
        `SELECT DISTINCT a->>'id' AS id, a->>'name' AS name FROM cross_connections c
          JOIN workspaces w ON w.operator_id = CASE WHEN c.to_owner_id=$1 THEN c.from_owner_id ELSE c.to_owner_id END
          CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a
          WHERE c.status IN ('approved','revoked') AND (
            (c.to_owner_id=$1 AND a->>'id'=c.from_agent_id) OR
            (c.from_owner_id=$1 AND a->>'id'=c.to_agent_id))
          AND a->>'id' = ANY($2::text[])`,
        [operatorId, missing],
      )
    ).rows;
    for (const row of rows) names.set(row.id, row.name);
    return names;
  }
  async function cursorOf(tx: Tx, agentId: string, lock = false) {
    const row = (
      await tx.query<{ next_seq: number | string; acked_seq: number | string }>(
        `SELECT next_seq,acked_seq FROM inbox_cursors WHERE agent_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [agentId],
      )
    ).rows[0];
    const latest = row ? Number(row.next_seq) - 1 : 0;
    const acked = row ? Number(row.acked_seq) : 0;
    return { latest, acked, unread: latest - acked };
  }
  async function replay(
    tx: Tx,
    receipt: { request_hash: string; recipient_id: string; seq: number | string },
    requestHash: string,
    workspace: Workspace,
    operatorId: string,
  ) {
    if (receipt.request_hash !== requestHash)
      fail(409, 'idempotency_conflict', 'This idempotency key belongs to a different message.');
    const row = (
      await tx.query<MessageRow>(
        `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq=$2`,
        [receipt.recipient_id, receipt.seq],
      )
    ).rows[0];
    if (!row) fail(410, 'message_expired', 'The original message is no longer retained.');
    const names = await namesFor(tx, operatorId, workspace, [row!.sender_id, row!.recipient_id]);
    return { message: project(row!, names) };
  }

  async function send(
    principal: MessagingPrincipal,
    senderId: string,
    input: SendInput,
    guard?: Guard,
  ): Promise<{ message: AgentMessage }> {
    if (principal.runtime && principal.runtime.agentId !== senderId)
      fail(403, 'forbidden', 'A runtime may only send as its own agent.');
    const parts: MessagePart[] =
      input.parts ?? (input.text !== undefined ? [{ type: 'text', text: input.text }] : []);
    if (!parts.length) fail(400, 'invalid_arguments', 'Pass exactly one of text or parts.');
    if (Buffer.byteLength(JSON.stringify(parts)) > MESSAGE_LIMITS.totalBytes)
      fail(413, 'message_too_large', `Messages are limited to ${MESSAGE_LIMITS.totalBytes} bytes.`);
    const requestHash = sha(
      canonical({
        to: input.to_agent_id,
        parts,
        context_id: input.context_id,
        reply_to: input.reply_to,
      }),
    );
    // Only new messages spend the sender's budget. The limiter runs before the transaction:
    // the hosted limiter needs its own pool connection, and acquiring one while a transaction
    // holds another can starve the small serverless pool. A plain read decides whether this is a
    // replay; replays are still answered, with full authorization, inside the transaction below.
    const known = await d.db.query(
      'SELECT 1 FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
      [senderId, input.idempotency_key],
    );
    if (!known.rows.length) {
      await d.limit(`msg-send:${principal.operatorId}:${senderId}`, perMinute, 60_000);
      // Cross-owner budgets (F4 §5), also charged before the transaction. Plain reads decide
      // whether the recipient is another owner's agent along an approved connection.
      const own = (
        await d.db.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
          principal.operatorId,
        ])
      ).rows[0]?.data;
      if (own && !own.agents.some((agent) => agent.id === input.to_agent_id)) {
        const link = (
          await d.db.query<{ to_owner_id: string }>(
            "SELECT to_owner_id FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND status='approved' LIMIT 1",
            [principal.operatorId, senderId, input.to_agent_id],
          )
        ).rows[0];
        if (link) {
          await d.limit(`xsend-pair:${senderId}:${input.to_agent_id}`, crossPair, 60_000);
          await d.limit(`xsend-in:${link.to_owner_id}`, crossInbound, 60_000);
        }
      }
    }
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      const workspace = await workspaceOf(tx, principal.operatorId);
      const sender = ownAgent(workspace, senderId, 'Sending');
      // A replay of an accepted send returns the original message before any other check, so
      // retries stay idempotent even if the connection or agents changed since, and cost no budget.
      const prior = (
        await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
          'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
          [sender.id, input.idempotency_key],
        )
      ).rows[0];
      if (prior) return replay(tx, prior, requestHash, workspace, principal.operatorId);
      let recipient = workspace.agents.find((agent) => agent.id === input.to_agent_id);
      let recipientOwner = principal.operatorId;
      let recipientWorkspace = workspace;
      let senderLabel: string | null = null;
      if (!recipient) {
        // Another owner's agent only along an APPROVED cross-owner connection (F4), checked here
        // inside the send transaction; a connection revoked mid-flight fails the next send.
        const link = (
          await tx.query<{ to_operator_id: string; from_owner_label: string }>(
            "SELECT to_owner_id AS to_operator_id, from_owner_label FROM cross_connections WHERE from_owner_id=$1 AND from_agent_id=$2 AND to_agent_id=$3 AND status='approved' LIMIT 1",
            [principal.operatorId, sender.id, input.to_agent_id],
          )
        ).rows[0];
        if (link) {
          senderLabel = link.from_owner_label;
          const other = (
            await tx.query<{ data: Workspace }>(
              'SELECT data FROM workspaces WHERE operator_id=$1',
              [link.to_operator_id],
            )
          ).rows[0]?.data;
          const found = other?.agents.find((agent) => agent.id === input.to_agent_id);
          if (other && found) {
            recipient = found;
            recipientOwner = link.to_operator_id;
            recipientWorkspace = other;
          }
        }
      }
      const cross = recipientOwner !== principal.operatorId;
      // One answer for unknown ids and unconnected agents of other owners (F4 §4), so ids
      // cannot be probed.
      if (!recipient)
        fail(
          403,
          'connection_required',
          'No approved connection from this agent to that agent; request one with city_request_connection.',
        );
      const to = recipient!;
      if (to.id === sender.id) fail(400, 'invalid_arguments', 'An agent cannot message itself.');
      for (const [agent, role] of [
        [sender, 'sending'],
        [to, 'recipient'],
      ] as const) {
        if (agent.revokedAt)
          fail(403, 'agent_revoked', `The ${role} agent ${agent.name} is revoked.`);
        if (agent.pausedAt) fail(409, 'agent_paused', `The ${role} agent ${agent.name} is paused.`);
      }
      if (workspace.paused) fail(409, 'workspace_paused', 'Workspace is paused.');
      if (cross && recipientWorkspace.paused)
        fail(409, 'workspace_paused', "The recipient's workspace is paused.");
      // Same rule as work requests: a current sender -> recipient connection between live agents
      // (for another workspace, the accepted cross-workspace connection checked above).
      if (!cross && !hasPermission(workspace, { requesterId: sender.id, providerId: to.id }))
        fail(
          403,
          'connection_required',
          `A directional connection from ${sender.name} to ${to.name} is required.`,
        );

      const messageId = randomUUID();
      const claimed = await tx.query(
        `INSERT INTO message_receipts(sender_id,idempotency_key,request_hash,message_id,recipient_id,seq,created_at)
         VALUES($1,$2,$3,$4,$5,0,$6) ON CONFLICT (sender_id,idempotency_key) DO NOTHING RETURNING message_id`,
        [sender.id, input.idempotency_key, requestHash, messageId, to.id, time],
      );
      if (!claimed.rows.length) {
        // Lost a race with a concurrent send using the same key.
        const receipt = (
          await tx.query<{ request_hash: string; recipient_id: string; seq: number | string }>(
            'SELECT request_hash,recipient_id,seq FROM message_receipts WHERE sender_id=$1 AND idempotency_key=$2',
            [sender.id, input.idempotency_key],
          )
        ).rows[0]!;
        return replay(tx, receipt, requestHash, workspace, principal.operatorId);
      }

      // An explicit id equal to this pair's old derivable id (#61) means "our conversation": it is
      // resolved like an omitted context_id, so the derivable id is never written again.
      const legacy = legacyPairContextId(sender.id, to.id);
      const explicit =
        input.context_id !== undefined && input.context_id !== legacy
          ? input.context_id
          : undefined;
      let contextId = explicit;
      if (input.reply_to) {
        const original = (
          await tx.query<{ context_id: string }>(
            'SELECT context_id FROM messages WHERE id=$1 AND (recipient_id=$2 OR sender_id=$2) LIMIT 1',
            [input.reply_to, sender.id],
          )
        ).rows[0];
        if (!original)
          fail(404, 'reply_not_found', 'reply_to must name a message this agent sent or received.');
        // A reply to a #61-era message of this pair continues the pair's stored conversation, not
        // the derivable id (reply_to itself is kept).
        if (original!.context_id !== legacy) contextId ??= original!.context_id;
      }
      if (explicit !== undefined) {
        // A caller-chosen thread must be new or one this agent already takes part in, so no one
        // can inject messages into a conversation between other agents by guessing its id.
        // Index probes only (messages_context_sender / messages_context_recipient, migration 19),
        // never a count over the thread. Ordering by a column the equality leaves free keeps the
        // planner on the index even for a huge thread, where a seq scan "until the first match"
        // would otherwise look cheap.
        const thread = (
          await tx.query<{ mine: boolean; used: boolean }>(
            `SELECT (SELECT created_at FROM messages WHERE context_id=$1 AND sender_id=$2
                       ORDER BY created_at DESC LIMIT 1) IS NOT NULL
                 OR (SELECT created_at FROM messages WHERE context_id=$1 AND recipient_id=$2
                       ORDER BY created_at DESC LIMIT 1) IS NOT NULL AS mine,
                    (SELECT created_at FROM messages WHERE context_id=$1
                       ORDER BY sender_id, created_at LIMIT 1) IS NOT NULL AS used`,
            [explicit, sender.id],
          )
        ).rows[0];
        if (thread?.used && !thread.mine)
          fail(
            403,
            'context_forbidden',
            'context_id names a conversation this agent does not take part in; omit it to continue your conversation with this agent, or choose a new id.',
          );
      }
      // No context_id and no reply_to: continue the pair's conversation instead of opening a new
      // one per message (UX audit #6). That is the context of the latest message between these
      // two agents in either direction (within the last PAIR_LOOKBACK messages of each inbox), else
      // the pair's stored default: a random id created once per pair (ON CONFLICT, so concurrent
      // first sends converge) and known only to the pair's owners. A latest message still under the
      // pair's #61 derivable id (not yet remediated) is not continued: the send falls through to
      // pair_contexts, which the remediation also uses, so the derivable id is never written again
      // and a send racing the remediation cannot leave a straggler under it.
      if (contextId === undefined) {
        const latest = (
          await tx.query<{ context_id: string }>(
            `SELECT context_id FROM (
               (SELECT context_id, created_at, id FROM messages
                 WHERE recipient_id=$1 AND sender_id=$2
                   AND seq > COALESCE((SELECT next_seq FROM inbox_cursors WHERE agent_id=$1), 1) - 1 - $3
                 ORDER BY seq DESC LIMIT 1)
               UNION ALL
               (SELECT context_id, created_at, id FROM messages
                 WHERE recipient_id=$2 AND sender_id=$1
                   AND seq > COALESCE((SELECT next_seq FROM inbox_cursors WHERE agent_id=$2), 1) - 1 - $3
                 ORDER BY seq DESC LIMIT 1)
             ) AS pair ORDER BY created_at DESC, id DESC LIMIT 1`,
            [to.id, sender.id, PAIR_LOOKBACK],
          )
        ).rows[0];
        if (latest && latest.context_id !== legacy) contextId = latest.context_id;
        else {
          const [low, high] = pairKey(sender.id, to.id);
          contextId =
            (
              await tx.query<{ context_id: string }>(
                `INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)
                 ON CONFLICT (low_id,high_id) DO NOTHING RETURNING context_id`,
                [low, high, randomUUID(), time],
              )
            ).rows[0]?.context_id ??
            (
              await tx.query<{ context_id: string }>(
                'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
                [low, high],
              )
            ).rows[0]!.context_id;
        }
      }

      if (cross) {
        // One remote workspace may hold at most a quarter of an inbox's unacknowledged capacity,
        // so a connected peer cannot crowd out everyone else writing to the same agent.
        const quota = Math.max(1, Math.floor(depth / 4));
        const pending = Number(
          (
            await tx.query<{ n: number | string }>(
              `SELECT count(*) AS n FROM messages m WHERE m.recipient_id=$1 AND m.sender_owner_id=$2
                AND m.seq > COALESCE((SELECT acked_seq FROM inbox_cursors WHERE agent_id=$1),0)`,
              [to.id, principal.operatorId],
            )
          ).rows[0]?.n ?? 0,
        );
        if (pending >= quota)
          fail(
            429,
            'remote_quota',
            `${to.name}'s inbox already holds ${quota} unacknowledged messages from your workspace; retry after it acknowledges some.`,
            30_000,
          );
      }

      await tx.query(
        'INSERT INTO inbox_cursors(agent_id,next_seq,acked_seq,updated_at) VALUES($1,1,0,$2) ON CONFLICT (agent_id) DO NOTHING',
        [to.id, time],
      );
      const allocated = (
        await tx.query<{ seq: number | string }>(
          `UPDATE inbox_cursors SET next_seq=next_seq+1, updated_at=$2
           WHERE agent_id=$1 AND next_seq-1-acked_seq < $3 RETURNING next_seq-1 AS seq`,
          [to.id, time, depth],
        )
      ).rows[0];
      if (!allocated)
        fail(
          429,
          'inbox_full',
          `${to.name}'s inbox holds ${depth} unacknowledged messages; retry after it acknowledges some.`,
          30_000,
        );
      const seq = Number(allocated!.seq);
      const row = (
        await tx.query<MessageRow>(
          `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,reply_to,kind,parts,created_at,origin,sender_owner_label)
           VALUES($1,$2,$3,$4,$5,$10,$6,$7,'message',$8::jsonb,$9,$11,$12) RETURNING ${COLUMNS}`,
          [
            to.id,
            seq,
            messageId,
            sender.id,
            principal.operatorId,
            contextId,
            input.reply_to ?? null,
            JSON.stringify(parts),
            time,
            recipientOwner,
            cross ? 'external' : 'internal',
            senderLabel,
          ],
        )
      ).rows[0]!;
      await tx.query(
        'UPDATE message_receipts SET seq=$3 WHERE sender_id=$1 AND idempotency_key=$2',
        [sender.id, input.idempotency_key, seq],
      );
      // @mentions of the recipient, webhook outbox and after-commit wake (docs/WAKE.md).
      await messageDelivered(tx, {
        recipientId: to.id,
        recipientName: to.name,
        recipientOwnerId: recipientOwner,
        senderId: sender.id,
        senderName: sender.name,
        senderOwnerLabel: senderLabel,
        messageId,
        seq,
        contextId: contextId!,
        parts,
        time,
      });
      const names = namesOf(workspace);
      names.set(to.id, to.name);
      return { message: project(row, names) };
    });
  }

  async function readInbox(
    principal: MessagingPrincipal,
    agentId: string,
    query: InboxQuery,
    guard?: Guard,
  ): Promise<InboxPage> {
    const limit = Math.min(query.limit ?? MESSAGE_LIMITS.defaultPageSize, MESSAGE_LIMITS.pageSize);
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      if (principal.runtime && principal.runtime.agentId !== agentId)
        fail(403, 'forbidden', 'A runtime may only read its own inbox.');
      const workspace = await workspaceOf(tx, principal.operatorId);
      ownAgent(workspace, agentId, 'Inbox');
      const cursor = await cursorOf(tx, agentId);
      let rows: MessageRow[];
      let hasMore: boolean;
      if (query.before !== undefined || (query.since === undefined && query.start === 'latest')) {
        const before = query.before ?? cursor.latest + 1;
        rows = (
          await tx.query<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq<$2 ORDER BY seq DESC LIMIT $3`,
            [agentId, before, limit + 1],
          )
        ).rows;
        hasMore = rows.length > limit;
        rows = rows.slice(0, limit).reverse();
      } else {
        const since = query.since ?? cursor.acked;
        rows = (
          await tx.query<MessageRow>(
            `SELECT ${COLUMNS} FROM messages WHERE recipient_id=$1 AND seq>$2 ORDER BY seq LIMIT $3`,
            [agentId, since, limit + 1],
          )
        ).rows;
        hasMore = rows.length > limit;
        rows = rows.slice(0, limit);
      }
      const names = await namesFor(
        tx,
        principal.operatorId,
        workspace,
        rows.map((row) => row.sender_id),
      );
      const messages = rows.map((row) => project(row, names));
      return {
        agent_id: agentId,
        messages,
        latest_seq: cursor.latest,
        acked_seq: cursor.acked,
        unread: cursor.unread,
        next_since: messages.at(-1)?.seq ?? query.since ?? cursor.acked,
        has_more: hasMore,
      };
    });
  }

  async function ack(
    principal: MessagingPrincipal,
    agentId: string,
    seq: number,
    guard?: Guard,
  ): Promise<InboxAck> {
    return d.db.transaction(async (tx) => {
      const time = d.clock();
      if (guard) await guard(tx, time);
      await runtimeCurrent(tx, principal);
      if (principal.runtime && principal.runtime.agentId !== agentId)
        fail(403, 'forbidden', 'A runtime may only acknowledge its own inbox.');
      const workspace = await workspaceOf(tx, principal.operatorId);
      ownAgent(workspace, agentId, 'Inbox');
      const cursor = await cursorOf(tx, agentId, true);
      if (seq > cursor.latest)
        fail(
          400,
          'ack_beyond_latest',
          `seq ${seq} is beyond the latest delivered message (${cursor.latest}).`,
        );
      if (seq <= cursor.acked)
        return {
          agent_id: agentId,
          acked_seq: cursor.acked,
          latest_seq: cursor.latest,
          unread: cursor.unread,
        };
      await tx.query('UPDATE inbox_cursors SET acked_seq=$2, updated_at=$3 WHERE agent_id=$1', [
        agentId,
        seq,
        time,
      ]);
      return {
        agent_id: agentId,
        acked_seq: seq,
        latest_seq: cursor.latest,
        unread: cursor.latest - seq,
      };
    });
  }

  async function summary(operatorId: string): Promise<{ inboxes: InboxSummary[] }> {
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const ids = workspace.agents.map((agent) => agent.id);
      const rows = (
        await tx.query<{ agent_id: string; next_seq: number | string; acked_seq: number | string }>(
          'SELECT agent_id,next_seq,acked_seq FROM inbox_cursors WHERE agent_id IN (SELECT jsonb_array_elements_text($1::jsonb))',
          [JSON.stringify(ids)],
        )
      ).rows;
      return {
        inboxes: rows.map((row) => {
          const latest = Number(row.next_seq) - 1,
            acked = Number(row.acked_seq);
          return {
            agent_id: row.agent_id,
            latest_seq: latest,
            acked_seq: acked,
            unread: latest - acked,
          };
        }),
      };
    });
  }

  async function conversations(
    operatorId: string,
    limit = 50,
  ): Promise<{ conversations: ConversationSummary[] }> {
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const groups = (
        await tx.query<{
          context_id: string;
          message_count: number | string;
          senders: string[];
          recipients: string[];
        }>(
          `SELECT context_id, count(*) AS message_count, max(created_at) AS last_at,
             jsonb_agg(DISTINCT sender_id) AS senders, jsonb_agg(DISTINCT recipient_id) AS recipients
           FROM messages WHERE (recipient_owner_id=$1 OR sender_owner_id=$1) GROUP BY context_id ORDER BY last_at DESC, context_id LIMIT $2`,
          [operatorId, Math.min(Math.max(limit, 1), 100)],
        )
      ).rows;
      if (!groups.length) return { conversations: [] };
      const latest = (
        await tx.query<MessageRow>(
          `SELECT DISTINCT ON (context_id) ${COLUMNS} FROM messages
           WHERE (recipient_owner_id=$1 OR sender_owner_id=$1) AND context_id IN (SELECT jsonb_array_elements_text($2::jsonb))
           ORDER BY context_id, created_at DESC, seq DESC, id DESC`,
          [operatorId, JSON.stringify(groups.map((group) => group.context_id))],
        )
      ).rows;
      const names = await namesFor(
        tx,
        operatorId,
        workspace,
        groups.flatMap((group) => [...group.senders, ...group.recipients]),
      );
      const byContext = new Map(latest.map((row) => [row.context_id, project(row, names)]));
      return {
        conversations: groups.map((group) => ({
          context_id: group.context_id,
          message_count: Number(group.message_count),
          participants: [...new Set([...group.senders, ...group.recipients])].sort(),
          last_message: byContext.get(group.context_id)!,
        })),
      };
    });
  }

  async function conversation(
    operatorId: string,
    contextId: string,
    options: { before?: string; limit?: number } = {},
  ) {
    const limit = Math.min(
      options.limit ?? MESSAGE_LIMITS.defaultPageSize,
      MESSAGE_LIMITS.pageSize,
    );
    // Cursor: created_at.seq.id of the oldest message on the previous page (newest-first order).
    let cursor: [number, number, string] | undefined;
    if (options.before !== undefined) {
      const match = /^(\d{1,16})\.(\d{1,16})\.([0-9a-f-]{36})$/.exec(options.before);
      if (!match) fail(400, 'invalid_arguments', 'before is not a valid conversation cursor.');
      cursor = [Number(match![1]), Number(match![2]), match![3]!];
    }
    return d.db.transaction(async (tx) => {
      const workspace = await workspaceOf(tx, operatorId);
      const rows = (
        await tx.query<MessageRow>(
          `SELECT ${COLUMNS} FROM messages WHERE (recipient_owner_id=$1 OR sender_owner_id=$1) AND context_id=$2
           ${cursor ? 'AND (created_at, seq, id::text) < ($4::bigint, $5::bigint, $6::text)' : ''}
           ORDER BY created_at DESC, seq DESC, id::text DESC LIMIT $3`,
          cursor
            ? [operatorId, contextId, limit + 1, ...cursor]
            : [operatorId, contextId, limit + 1],
        )
      ).rows;
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      const oldest = page.at(-1);
      const names = await namesFor(
        tx,
        operatorId,
        workspace,
        page.flatMap((row) => [row.sender_id, row.recipient_id]),
      );
      return {
        context_id: contextId,
        messages: page.reverse().map((row) => project(row, names)),
        has_more: hasMore,
        next_before:
          hasMore && oldest
            ? `${Number(oldest.created_at)}.${Number(oldest.seq)}.${oldest.id}`
            : null,
      };
    });
  }

  return { send, readInbox, ack, summary, conversations, conversation };
}
