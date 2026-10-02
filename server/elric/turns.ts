import { createHash, randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';
import type { ElricOutcome } from './schema.js';

/**
 * The append-only Elric turn log (docs/ELRIC.md; THREAT_PRIVACY_REVIEW §10.8). One row per
 * invocation decision, refused or answered, with the invoker, the room, the context seq range,
 * tier, model, tokens, cost units, every tool call (name, arguments hash, result status), the
 * outcome and the posted seq. The table refuses UPDATE, DELETE and TRUNCATE (trigger). The owner
 * reads it, paginated and never truncated.
 */
export type ToolCallStatus =
  | 'ok'
  | 'refused_not_allowed'
  | 'refused_room'
  | 'refused_disabled'
  | 'refused_args'
  | 'refused_pending'
  | 'refused_cap'
  | 'cancelled'
  | 'error';

/**
 * One tool call as audited. `name` is an allowlisted tool name or 'other': a model-chosen
 * string is never stored; `name_hash` (sha256 of the requested name) lets an auditor match a
 * known name offline.
 */
export interface ToolCallRecord {
  name: 'room_read' | 'room_task_create' | 'other';
  name_hash: string;
  args_hash: string;
  status: ToolCallStatus;
}

export interface TurnInput {
  ownerId: string;
  agentId: string;
  roomId: string;
  invokerMemberId: string;
  invokerKind: 'owner' | 'host' | 'other';
  sourceSeq: number;
  contextFromSeq?: number | null;
  contextToSeq?: number | null;
  tier?: 0 | 1 | 2 | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUnits?: number;
  reservedUnits?: number;
  toolCalls?: ToolCallRecord[];
  outcome: ElricOutcome;
  reason?: string | null;
  postedSeq?: number | null;
}

/** Canonical JSON (sorted keys), so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as object)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
export const argsHash = (args: unknown) =>
  createHash('sha256').update(canonicalJson(args)).digest('hex');

export async function recordTurn(
  q: Pick<Tx, 'query'>,
  turn: TurnInput,
  time: number,
): Promise<string> {
  const id = randomUUID();
  await q.query(
    `INSERT INTO elric_turns(id,owner_id,agent_id,room_id,invoker_member_id,invoker_kind,source_seq,
       context_from_seq,context_to_seq,tier,model,input_tokens,output_tokens,cost_units,tool_calls,
       outcome,reason,posted_seq,created_at,reserved_units,cache_read_tokens,cache_write_tokens)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21,$22)`,
    [
      id,
      turn.ownerId,
      turn.agentId,
      turn.roomId,
      turn.invokerMemberId,
      turn.invokerKind,
      turn.sourceSeq,
      turn.contextFromSeq ?? null,
      turn.contextToSeq ?? null,
      turn.tier ?? null,
      turn.model ?? null,
      turn.inputTokens ?? 0,
      turn.outputTokens ?? 0,
      turn.costUnits ?? 0,
      JSON.stringify(turn.toolCalls ?? []),
      turn.outcome,
      turn.reason ?? null,
      turn.postedSeq ?? null,
      time,
      turn.reservedUnits ?? 0,
      turn.cacheReadTokens ?? 0,
      turn.cacheWriteTokens ?? 0,
    ],
  );
  return id;
}

/**
 * What came of a turn, for the owner's activity view: `posted` (a reply is in the room), `refused`
 * (an access, eligibility, kill switch or credential check said no), `limit` (an allowance,
 * ceiling or step cap stopped it before a post), `cancelled` (paused, revoked or expired) or
 * `error`. `reason_code` is the stored reason, else the outcome.
 */
export const ELRIC_RESULTS = ['posted', 'refused', 'limit', 'cancelled', 'error'] as const;
export type ElricResult = (typeof ELRIC_RESULTS)[number];

export function turnResult(outcome: ElricOutcome, postedSeq: number | null): ElricResult {
  if (postedSeq !== null) return 'posted';
  if (outcome.startsWith('refused_')) return 'refused';
  if (outcome === 'limit' || outcome === 'step_limit') return 'limit';
  if (outcome === 'cancelled' || outcome === 'expired') return 'cancelled';
  return 'error';
}

/** The same mapping as SQL, for the `result` filter (kept in step with turnResult). */
const RESULT_SQL: Record<ElricResult, string> = {
  posted: 't.posted_seq IS NOT NULL',
  refused: "t.posted_seq IS NULL AND t.outcome LIKE 'refused\\_%'",
  limit: "t.posted_seq IS NULL AND t.outcome IN ('limit','step_limit')",
  cancelled: "t.posted_seq IS NULL AND t.outcome IN ('cancelled','expired')",
  // 'pending' (a consequential tool waits for the owner) without a post counts as error, as in
  // turnResult; a posted pending turn is 'posted'.
  error: "t.posted_seq IS NULL AND t.outcome IN ('ok','error','pending')",
};

export interface TurnView {
  id: string;
  agent_id: string;
  /** The room id while the owner can still see the room (like `room`), else null. */
  room_id: string | null;
  invoker_member_id: string;
  invoker_kind: 'owner' | 'host' | 'other';
  source_seq: number;
  context: { from_seq: number; to_seq: number } | null;
  tier: 0 | 1 | 2 | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_units: number;
  reserved_units: number;
  tool_calls: ToolCallRecord[];
  outcome: ElricOutcome;
  reason: string | null;
  posted_seq: number | null;
  created_at: string;
  /** posted, refused, limit, cancelled or error (turnResult) and its reason code. */
  result: ElricResult;
  reason_code: string;
  /**
   * The room while the owner can still see it (an active membership in a room that is not
   * deleted), else null. Only the id and name; never message content.
   */
  room: { id: string; name: string } | null;
  /** The room page of the posted reply, when there is one and the room is visible. */
  link: string | null;
}

type TurnRow = {
  id: string;
  agent_id: string;
  room_id: string;
  invoker_member_id: string;
  invoker_kind: 'owner' | 'host' | 'other';
  source_seq: string | number;
  context_from_seq: string | number | null;
  context_to_seq: string | number | null;
  tier: number | null;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_units: string | number;
  reserved_units: string | number;
  tool_calls: ToolCallRecord[];
  outcome: ElricOutcome;
  reason: string | null;
  posted_seq: string | number | null;
  created_at: string | number;
  room_name: string | null;
};

const cursorOf = (row: TurnRow) =>
  Buffer.from(`${Number(row.created_at)}:${row.id}`).toString('base64url');
/** A cursor this route did not hand out is a 400, never a silent restart at the first page. */
function parseCursor(cursor: string | undefined): { at: number; id: string } | null {
  if (!cursor) return null;
  const [at, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
  if (!at || !id || extra !== undefined || !/^\d{1,15}$/.test(at) || !/^[0-9a-f-]{36}$/.test(id))
    throw Object.assign(new Error('Invalid cursor: pass next_cursor from the last page.'), {
      statusCode: 400,
      errorCode: 'invalid_cursor',
    });
  return { at: Number(at), id };
}

/**
 * The owner's turns, newest first, `limit` (1-100) per page with an opaque `cursor`. Only rows
 * of this owner's Elric(s) are ever returned; there is no cap on how far back one may page.
 */
export async function listElricTurns(
  q: Pick<Tx, 'query'>,
  ownerId: string,
  options: { cursor?: string; limit?: number; roomId?: string; result?: ElricResult } = {},
): Promise<{ turns: TurnView[]; next_cursor: string | null }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const after = parseCursor(options.cursor);
  const result = options.result && RESULT_SQL[options.result];
  const rows = (
    await q.query<TurnRow>(
      `SELECT t.*,
              (SELECT r.name FROM rooms r
                WHERE r.id=t.room_id AND r.deleted_at IS NULL
                  AND EXISTS (SELECT 1 FROM room_members m WHERE m.room_id=r.id
                                AND m.owner_id=t.owner_id AND m.removed_at IS NULL)) AS room_name
         FROM elric_turns t WHERE t.owner_id=$1
          AND ($2::text IS NULL OR t.room_id=$2)
          AND ($3::bigint IS NULL OR (t.created_at, t.id) < ($3::bigint, $4::text))
          ${result ? `AND ${result}` : ''}
        ORDER BY t.created_at DESC, t.id DESC LIMIT $5`,
      [ownerId, options.roomId ?? null, after?.at ?? null, after?.id ?? '', limit + 1],
    )
  ).rows;
  const page = rows.slice(0, limit);
  return {
    turns: page.map((row) => ({
      id: row.id,
      agent_id: row.agent_id,
      room_id: row.room_name === null ? null : row.room_id,
      invoker_member_id: row.invoker_member_id,
      invoker_kind: row.invoker_kind,
      source_seq: Number(row.source_seq),
      context:
        row.context_from_seq === null || row.context_to_seq === null
          ? null
          : { from_seq: Number(row.context_from_seq), to_seq: Number(row.context_to_seq) },
      tier: row.tier === null ? null : (Number(row.tier) as 0 | 1 | 2),
      model: row.model,
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      cost_units: Number(row.cost_units),
      reserved_units: Number(row.reserved_units),
      tool_calls: row.tool_calls ?? [],
      outcome: row.outcome,
      reason: row.reason,
      posted_seq: row.posted_seq === null ? null : Number(row.posted_seq),
      created_at: new Date(Number(row.created_at)).toISOString(),
      result: turnResult(row.outcome, row.posted_seq === null ? null : Number(row.posted_seq)),
      reason_code: row.reason ?? row.outcome,
      room: row.room_name === null ? null : { id: row.room_id, name: row.room_name },
      link:
        row.room_name !== null && row.posted_seq !== null
          ? `/rooms/${encodeURIComponent(row.room_id)}`
          : null,
    })),
    next_cursor: rows.length > limit ? cursorOf(page.at(-1)!) : null,
  };
}
