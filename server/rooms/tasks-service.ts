import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { iso, type StoredAgent, type Workspace } from '../model.js';
import {
  RoomError,
  refuseIfMuted,
  roomDeleted,
  roomNotFound,
  type RoomPrincipal,
} from './service.js';
import { memberStatuses, touchMembers } from './member-status.js';
import { ROOM_LIMITS } from './contract.js';
import { lineTitle, memberLabel, postSystemLine } from './system-lines.js';
import {
  TASK_LIMITS,
  graceForTtl,
  taskClaimInput,
  taskCreateInput,
  taskEventsInput,
  taskGetInput,
  taskListInput,
  taskReleaseInput,
  taskRenewInput,
  taskResultInput,
  taskUpdateInput,
  type TaskEvidence,
  type TaskEventView,
  type TaskLimits,
  type TaskStatus,
  type TaskView,
} from './tasks-contract.js';
import { scopedByPrincipal, visibleRoom, withoutElricAgents } from './private.js';

export type { RoomPrincipal };

/** One claim the lapse sweep cleared (PR2, plan §6 milestone 2). */
export interface LapsedTask {
  task_id: string;
  agent_id: string | null;
  generation: number;
}

/**
 * Room tasks service (claims core; docs/ROOM_TASKS.md). Standalone: it never edits the
 * rooms service, tools or app wiring; it only reads rooms, room_members and workspaces.
 *
 * Binding review notes, how each is honored:
 * 1. Presence: no new columns. Member activity reuses the rooms `room_members.last_active_at`
 *    (migration 21) through `touchMembers`; nothing here reads agent_presence heartbeats.
 * 2. The database clock stamps and compares every lease: `DBNOW` is
 *    `(EXTRACT(EPOCH FROM now())*1000)::bigint` inline in SQL. `d.clock()` is used only
 *    for `touchMembers` (the existing app-clock semantics) and never for a lease.
 * 3. Lazy lapse keeps the CHECK true: the lapse statements clear the whole `claim_*`
 *    group and set `status='open'` (plus a generation bump) in one UPDATE. No cron
 *    exists yet, so reads lapse inline and a post-grace claim takes over atomically.
 * 4. Claim tokens are 128-bit (`ccclaim_` + base64url of 16 random bytes, so a posted
 *    token trips the room credential filter); only the SHA-256 is stored, tokens never
 *    reach logs or errors, and every claim mints a NEW token. Renew keeps the token and
 *    returns expiries only, never a token.
 * 5. `attachment_ids` are validated against the step-1 attachments table (each id must
 *    belong to this room and be `ready`); anything else is `409 attachment_not_ready`.
 *    There is no foreign key. While migration 27 is not applied the table is absent and
 *    any non-empty list fails closed.
 * 6. Titles and bodies are returned verbatim as untrusted text; bodies share the 16 KB cap.
 * 7. `room_task_events` is append-only with an index on `(task_id, created_at)` and
 *    keyset-paged reads. Stale rejections ARE recorded (PR2, plan §4 A2): a 409 rolls
 *    its transaction back, so `auditStale` writes `stale_rejected` in its own
 *    statement after renew/release/result refuse a stale token.
 * 8. Claim is one conditional `UPDATE … RETURNING` (grace included). Rate limits are
 *    charged before any transaction: the hosted limiter needs its own pool client and
 *    the pool holds at most 3.
 */
const HOUR = 3_600_000;
/** Database clock in epoch milliseconds, for every lease stamp and comparison. */
const DBNOW = `(EXTRACT(EPOCH FROM now())*1000)::bigint`;

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

/** A room-task failure. `details` carries the machine-readable 409 payloads. */
export class TaskError extends RoomError {
  constructor(
    statusCode: number,
    errorCode: string,
    message: string,
    public details?: unknown,
    retryAfterMs?: number,
  ) {
    super(statusCode, errorCode, message, retryAfterMs);
  }
}
const refuse = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
  retryAfterMs?: number,
): never => {
  throw new TaskError(status, code, message, details, retryAfterMs);
};
/** `409 claim_stale {current_holder, generation}`: nothing changed. */
const stale = (row: TaskRow): never =>
  refuse(409, 'claim_stale', 'The claim token is stale; the task changed hands or lapsed.', {
    current_holder: row.claim_agent_id,
    generation: Number(row.claim_generation),
  });

/** 128-bit claim token. The `ccclaim_` prefix trips the room credential filter. */
const mintClaimToken = () => `ccclaim_${randomBytes(16).toString('base64url')}`;
const tokenHashOf = (token: string) => sha(`room-task-claim:${token}`);

async function insertTaskEvent(
  q: Pick<Tx, 'query'>,
  taskId: string,
  action: string,
  generation: number,
  actor: string,
  agentId: string | null,
  details?: unknown,
): Promise<void> {
  await q.query(
    `INSERT INTO room_task_events(id,task_id,action,generation,actor,agent_id,details,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,${DBNOW})`,
    [
      randomUUID(),
      taskId,
      action,
      generation,
      actor,
      agentId,
      details === undefined ? null : JSON.stringify(details),
    ],
  );
}

/**
 * Lapse sweep as a pure function (PR2, plan §6 milestone 2): one UPDATE ...
 * RETURNING lapses every past-grace claim (the same CHECK-safe clear as lazy
 * lapse), batch-limited, with one `lapsed` event each. No cron wiring here
 * (the wake cron runs it); lazy lapse stays. No limiter
 * inside: the caller (cron) is not request-charged. Database clock throughout.
 */
export async function sweepLapsedTasks(
  db: Database,
  limit: number,
): Promise<{ lapsed: LapsedTask[] }> {
  const batch = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), 1000)) : 100;
  return db.transaction(async (tx) => {
    // One statement: the CTE picks the batch, the UPDATE clears it, and the outer
    // SELECT recovers the pre-update holders (RETURNING only sees the new row).
    const cleared = (
      await tx.query<{
        id: string;
        claim_generation: string | number;
        claim_agent_id: string | null;
      }>(
        `WITH due AS (
          SELECT id,claim_agent_id FROM room_tasks
          WHERE status='claimed' AND claim_expires_at + claim_grace_ms <= ${DBNOW}
          ORDER BY claim_expires_at LIMIT $1
        ), cleared AS (
          UPDATE room_tasks t SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          FROM due WHERE t.id=due.id AND t.status='claimed'
            AND t.claim_expires_at + t.claim_grace_ms <= ${DBNOW}
          RETURNING t.id, t.claim_generation
        )
        SELECT cleared.id, cleared.claim_generation, due.claim_agent_id
        FROM cleared JOIN due ON due.id=cleared.id`,
        [batch],
      )
    ).rows;
    for (const row of cleared)
      await insertTaskEvent(
        tx,
        row.id,
        'lapsed',
        Number(row.claim_generation),
        'system',
        row.claim_agent_id,
      );
    return {
      lapsed: cleared.map((row) => ({
        task_id: row.id,
        agent_id: row.claim_agent_id,
        generation: Number(row.claim_generation),
      })),
    };
  });
}

type RoomRow = {
  id: string;
  slug: string;
  host_owner_id: string;
  closed_at: string | number | null;
};
type MemberRow = { agent_id: string; role: string };
type TaskRow = {
  id: string;
  room_id: string;
  number: string | number;
  title: string;
  body: string;
  status: string;
  created_by_agent_id: string;
  created_by_owner_id: string;
  from_message_seq: string | number | null;
  attachment_ids: string[] | null;
  claim_agent_id: string | null;
  claim_owner_id: string | null;
  claim_expires_at: string | number | null;
  claim_ttl_ms: string | number | null;
  claim_grace_ms: string | number | null;
  claim_token_hash: string | null;
  claim_generation: string | number;
  result: unknown;
  created_at: string | number;
  updated_at: string | number;
  idempotency_key: string;
  request_hash: string;
};
type TaskEventRow = {
  id: string;
  task_id: string;
  action: string;
  generation: string | number | null;
  actor: string;
  agent_id: string | null;
  details: unknown;
  created_at: string | number;
};

export interface TaskDependencies {
  db: Database;
  /** App clock for member-activity touches only; leases always use the database clock. */
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  /** The rooms secret: keys the per-member bucket offsets in `memberStatuses`. */
  secret: string;
}

export interface RoomTasks {
  /**
   * `precondition` is internal only (Elric, docs/ELRIC.md): it runs under the room lock inside the
   * create transaction, and a returned code refuses the create (409).
   */
  create(
    p: RoomPrincipal,
    body: unknown,
    options?: { precondition?: (tx: Pick<Tx, 'query'>) => Promise<string | null> },
  ): Promise<{ task: TaskView; replayed: boolean }>;
  get(p: RoomPrincipal, body: unknown): Promise<{ task: TaskView }>;
  list(p: RoomPrincipal, body: unknown): Promise<{ room_id: string; tasks: TaskView[] }>;
  claim(
    p: RoomPrincipal,
    body: unknown,
  ): Promise<{
    task: TaskView;
    claim_token: string;
    generation: number;
    expires_at: string;
    grace_until: string;
  }>;
  renew(
    p: RoomPrincipal,
    body: unknown,
  ): Promise<{ task: TaskView; expires_at: string; grace_until: string }>;
  release(p: RoomPrincipal, body: unknown): Promise<{ task: TaskView; released: boolean }>;
  result(p: RoomPrincipal, body: unknown): Promise<{ task: TaskView }>;
  update(
    p: RoomPrincipal,
    body: unknown,
  ): Promise<{
    task: TaskView;
    decision: 'approve' | 'reject' | 'cancel';
    applied: boolean;
  }>;
  events(
    p: RoomPrincipal,
    body: unknown,
  ): Promise<{
    task_id: string;
    events: TaskEventView[];
    next_after: string | null;
    has_more: boolean;
  }>;
  limits: TaskLimits;
}

function project(row: TaskRow): TaskView {
  return {
    id: row.id,
    room_id: row.room_id,
    number: Number(row.number),
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    created_by_agent_id: row.created_by_agent_id,
    from_message_seq: row.from_message_seq === null ? null : Number(row.from_message_seq),
    attachment_ids: [...(row.attachment_ids ?? [])],
    claim:
      row.claim_agent_id === null
        ? null
        : {
            agent_id: row.claim_agent_id,
            expires_at: iso(Number(row.claim_expires_at)),
            grace_until: iso(Number(row.claim_expires_at) + Number(row.claim_grace_ms)),
            generation: Number(row.claim_generation),
          },
    result: (row.result as TaskEvidence | null) ?? null,
    created_at: iso(Number(row.created_at)),
    updated_at: iso(Number(row.updated_at)),
  };
}

function projectEvent(row: TaskEventRow): TaskEventView {
  // `details` arrives parsed from jsonb (or null); pass it through as-is. Older
  // rows predate migration 30 and select as null/undefined.
  const raw = (row as { details?: unknown }).details ?? null;
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as unknown;
  // `stale_rejected` keys its dedupe on `attempted_by` (an opaque per-task HMAC of the owner):
  // internal only, never shown. `attempted_by_owner` is dropped too, so no operator id ever
  // reaches room members.
  let details = parsed;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const {
      attempted_by: _key,
      attempted_by_owner: _owner,
      ...shown
    } = parsed as Record<string, unknown>;
    details = shown;
  }
  return {
    id: row.id,
    task_id: row.task_id,
    action: row.action as TaskEventView['action'],
    generation: row.generation === null ? null : Number(row.generation),
    actor: row.actor,
    agent_id: row.agent_id,
    details,
    created_at: iso(Number(row.created_at)),
  };
}

/**
 * PR2 additions (plan §6 milestone 2), same rules as PR1: database clock, no limiter
 * inside transactions, low-entropy literals, exported types.
 * - `result`/`update`: claimed -> in_review (holder posts revision-bound evidence,
 *   inside lease + grace only, 06c) -> done (host approves) or open (host
 *   rejects, evidence cleared from the task but copied to the `rejected` event
 *   payload marked `untrusted: true`, 06c, PR3); host cancels.
 * - `stale_rejected` events: every `claim_stale` 409 from renew/release/result is
 *   audited in a separate statement after the refused transaction rolls back,
 *   deduplicated to one per (task, attempting owner/agent, generation) per
 *   minute (06c, PR3: the actor label is not unique, so the attempter is keyed
 *   in `details`).
 * - Claim-stale matrix on every touch: past-grace lapse (kept), removed holders and
 *   `access_expired` holders (via `memberStatuses`, read at read time)
 *   released with an event, closed rooms release all claims on read.
 */
export function createRoomTasks(d: TaskDependencies): RoomTasks {
  const limits: TaskLimits = { ...TASK_LIMITS };
  /**
   * A short plain-language line in the room thread for a task change (system-lines.ts; no
   * ids or tokens, no wake, mention or auto-reply). Callers hold the room row lock first.
   */
  const taskRef = (row: Pick<TaskRow, 'number' | 'title'>) =>
    `task #${Number(row.number)}: ${lineTitle(row.title)}`;
  const taskLine = (tx: Pick<Tx, 'query'>, roomId: string, text: string) =>
    postSystemLine(tx, roomId, text, d.clock(), ROOM_LIMITS.messagesPerRoom);
  /** The room row lock, taken before any task row lock (the order post and create use). */
  const lockRoom = (tx: Pick<Tx, 'query'>, roomId: string) =>
    tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [roomId]);

  async function findRoom(q: Pick<Tx, 'query'>, ref: string) {
    // A private Elric chat: only the owner console and Elric (rooms/private.ts).
    return visibleRoom(
      (
        await q.query<RoomRow & { elric_private?: boolean }>(
          'SELECT * FROM rooms WHERE id=$1 OR slug=$1',
          [ref],
        )
      ).rows[0],
    );
  }

  async function liveAgents(
    q: Pick<Tx, 'query'>,
    operatorId: string,
  ): Promise<Map<string, StoredAgent>> {
    const data = (
      await q.query<{ data: Workspace }>('SELECT data FROM workspaces WHERE operator_id=$1', [
        operatorId,
      ])
    ).rows[0]?.data;
    if (!data) refuse(401, 'unauthorized', 'Sign in to continue.');
    return new Map(
      data!.agents.filter((agent) => !agent.revokedAt).map((agent) => [agent.id, agent]),
    );
  }

  /**
   * The caller's live memberships in the room. Unknown rooms and non-members share one
   * answer (`404 room_not_found`) so task ids cannot be probed.
   */
  async function membership(q: Pick<Tx, 'query'>, roomRef: string, operatorId: string) {
    const room = await findRoom(q, roomRef);
    if (!room) roomNotFound();
    // A deleted room (migration 35): 410 for its host and former members, 404 for anyone else.
    if ((room as { deleted_at?: unknown }).deleted_at != null) {
      const former = await q.query(
        'SELECT 1 FROM room_members WHERE room_id=$1 AND owner_id=$2 LIMIT 1',
        [room!.id, operatorId],
      );
      if (former.rows.length || room!.host_owner_id === operatorId) roomDeleted();
      roomNotFound();
    }
    const agents = await liveAgents(q, operatorId);
    const members = (
      await q.query<MemberRow>(
        'SELECT agent_id,role FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
        [room!.id, operatorId],
      )
    ).rows.filter((row) => agents.has(row.agent_id));
    if (!members.length) roomNotFound();
    // Reads keep every membership (a host whose only member is their Elric still reads tasks);
    // writes act only through `actors`: never an agent that is or was an Elric, except Elric's
    // own runtime.
    const actors = await withoutElricAgents(q, members);
    return { room: room!, members, actors };
  }

  /** The acting member agent: explicit, or the caller's only agent in the room. */
  function actingAgent(
    members: MemberRow[],
    agentId: string | undefined,
    actors: MemberRow[] = members,
  ) {
    if (agentId !== undefined && !actors.some((row) => row.agent_id === agentId)) {
      if (members.some((row) => row.agent_id === agentId))
        refuse(403, 'elric_posts_itself', 'Only Elric acts as Elric.');
    }
    members = actors;
    if (agentId !== undefined) {
      const member = members.find((row) => row.agent_id === agentId);
      if (!member) refuse(403, 'not_a_member', 'That agent is not a member of this room.');
      return member!;
    }
    if (members.length === 1) return members[0]!;
    return refuse(
      400,
      'agent_required',
      'You have several agents in this room; pass agent_id to choose.',
    );
  }

  /** Writes need a posting member in an open room. */
  function writeGuards(room: RoomRow, member: MemberRow) {
    if (room.closed_at !== null)
      refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
    if (member.role === 'guest') refuse(403, 'read_only', 'Guests can read but not claim.');
  }

  function missingTable(error: unknown): boolean {
    const code = (error as { code?: unknown }).code;
    if (code === '42P01') return true;
    return /relation .* does not exist|undefined table/i.test((error as Error).message ?? '');
  }

  /**
   * Every attachment id must belong to this room and be `ready` (the attachments table,
   * migration 27). No foreign key: the check lives here. While that table is absent
   * any non-empty list fails closed.
   */
  async function assertAttachmentsReady(
    tx: Pick<Tx, 'query'>,
    roomId: string,
    ids: readonly string[],
  ): Promise<void> {
    if (!ids.length) return;
    const unique = [...new Set(ids)];
    let ready: { id: string }[];
    try {
      ready = (
        await tx.query<{ id: string }>(
          'SELECT id FROM room_attachments WHERE room_id=$1 AND id = ANY($2::text[]) AND status=$3',
          [roomId, unique, 'ready'],
        )
      ).rows;
    } catch (error) {
      if (missingTable(error))
        refuse(
          409,
          'attachment_not_ready',
          'The task references attachments that are not ready in this room.',
        );
      throw error;
    }
    if (ready!.length !== unique.length)
      refuse(
        409,
        'attachment_not_ready',
        'The task references attachments that are not ready in this room.',
      );
  }

  async function recordEvent(
    tx: Pick<Tx, 'query'>,
    taskId: string,
    action: TaskEventRow['action'],
    generation: number,
    actor: string,
    agentId: string | null,
    details?: unknown,
  ): Promise<void> {
    await insertTaskEvent(tx, taskId, action, generation, actor, agentId, details);
  }

  /**
   * `stale_rejected` audit (PR2, deferred from PR1): a 409 rolls its own
   * transaction back, so the event is written here in a separate statement after
   * the refusal, and the original 409 still reaches the caller. Audit only: a
   * failed audit row never masks the 409 the caller already earned. Deduplicated
   * (PR3): at most one row per (task, attempting owner/agent,
   * generation) per minute, so a token flood cannot write ~120 rows/min. The
   * actor LABEL ('the owner', 'invited AI') is not unique across owners, so the
   * attempting owner id (and best-effort agent id) are recorded in the existing
   * `details` jsonb (migration 30; no new migration) and keyed there; the
   * `actor` column keeps the label and `agent_id` keeps the current holder.
   */
  async function auditStale(roomRef: string, taskId: string, p: RoomPrincipal): Promise<void> {
    try {
      const room = await findRoom(d.db, roomRef);
      if (!room) return;
      const current = (
        await d.db.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          taskId,
          room.id,
        ])
      ).rows[0];
      if (!current) return;
      const generation = Number(current.claim_generation);
      // Best-effort attempting agent: the caller's only live member agent, else
      // null (renew/release/result carry no agent_id). The owner id is exact.
      let attemptingAgent: string | null = null;
      try {
        const mine = (
          await d.db.query<{ agent_id: string }>(
            'SELECT agent_id FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
            [room.id, p.operatorId],
          )
        ).rows.map((row) => row.agent_id);
        if (mine.length === 1) attemptingAgent = mine[0]!;
      } catch {
        attemptingAgent = null;
      }
      // Opaque per-task owner key: dedupes per owner without storing or showing the operator id.
      const attemptedBy = createHmac('sha256', d.secret)
        .update(`room-task-stale:${taskId}:${p.operatorId}`)
        .digest('base64url')
        .slice(0, 22);
      const recent = (
        await d.db.query<{ one: number }>(
          `SELECT 1 AS one FROM room_task_events
            WHERE task_id=$1 AND action='stale_rejected' AND generation=$2
              AND details->>'attempted_by'=$3
              AND COALESCE(details->>'attempted_by_agent','')=COALESCE($4,'')
              AND created_at > ${DBNOW} - 60000
            LIMIT 1`,
          [taskId, generation, attemptedBy, attemptingAgent],
        )
      ).rows[0];
      if (recent) return;
      await insertTaskEvent(
        d.db,
        taskId,
        'stale_rejected',
        generation,
        p.actor,
        current.claim_agent_id,
        {
          attempted_by: attemptedBy,
          attempted_by_agent: attemptingAgent,
        },
      );
    } catch {
      // Audit only; the 409 below is the contract.
    }
  }

  /**
   * Claim-stale matrix, holder half (PR2, plan §4 A2): on every touch, release
   * claims whose holder is gone or locked out, with one `released` event each:
   * - the holder's membership was removed (or was never live);
   * - the rooms service reports the holder `access_expired`, derived here from the credential
   *   row at read time through `memberStatuses` (binding review note
   *   1: no new columns, and no new view fields either).
   * Past-grace lapse stays separate (lapseTask/lapseRoom); room-closed release
   * lives in releaseClosedClaims.
   */
  async function releaseInvalidHolders(tx: Tx, room: RoomRow, taskId?: string): Promise<void> {
    const held = (
      await tx.query<{ id: string; claim_agent_id: string }>(
        `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'
          AND ($2::text IS NULL OR id=$2)`,
        [room.id, taskId ?? null],
      )
    ).rows;
    if (!held.length) return;
    const holders = [...new Set(held.map((row) => row.claim_agent_id))];
    const live = new Set(
      (
        await tx.query<{ agent_id: string }>(
          'SELECT agent_id FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[]) AND removed_at IS NULL',
          [room.id, holders],
        )
      ).rows.map((row) => row.agent_id),
    );
    const liveHolders = holders.filter((id) => live.has(id));
    const rows = liveHolders.length
      ? (
          await tx.query<{
            agent_id: string;
            owner_id: string;
            joined_at: string | number;
          }>(
            'SELECT agent_id,owner_id,joined_at FROM room_members WHERE room_id=$1 AND agent_id = ANY($2::text[]) AND removed_at IS NULL',
            [room.id, liveHolders],
          )
        ).rows
      : [];
    const now = Number(
      (await tx.query<{ now: string | number }>(`SELECT ${DBNOW} AS now`)).rows[0]!.now,
    );
    const statuses = await memberStatuses(
      tx,
      { id: room.id, host_owner_id: room.host_owner_id },
      rows,
      room.host_owner_id,
      now,
      d.secret,
    );
    const invalid = new Set(
      held
        .filter(
          (row) =>
            !live.has(row.claim_agent_id) ||
            statuses.get(row.claim_agent_id)?.status === 'access_expired',
        )
        .map((row) => row.claim_agent_id),
    );
    if (!invalid.size) return;
    for (const row of held.filter((item) => invalid.has(item.claim_agent_id))) {
      const cleared = (
        await tx.query<{ id: string; claim_generation: string | number }>(
          `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_agent_id=$3
          RETURNING id, claim_generation`,
          [row.id, room.id, row.claim_agent_id],
        )
      ).rows[0];
      if (cleared)
        await recordEvent(
          tx,
          cleared.id,
          'released',
          Number(cleared.claim_generation),
          'system',
          row.claim_agent_id,
        );
    }
  }

  /**
   * Claim-stale matrix, room half (PR2): room closed -> claims released. Close
   * itself stays in the rooms service (this module never edits it), so the next
   * read on a closed room releases every remaining claim with one `released`
   * event each. Open rooms return at once.
   */
  async function releaseClosedClaims(tx: Tx, room: RoomRow): Promise<void> {
    if (room.closed_at === null) return;
    const holders = new Map(
      (
        await tx.query<{ id: string; claim_agent_id: string | null }>(
          `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'`,
          [room.id],
        )
      ).rows.map((row) => [row.id, row.claim_agent_id] as const),
    );
    if (!holders.size) return;
    const cleared = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE room_id=$1 AND status='claimed'
        RETURNING id, claim_generation`,
        [room.id],
      )
    ).rows;
    for (const row of cleared)
      await recordEvent(
        tx,
        row.id,
        'released',
        Number(row.claim_generation),
        'system',
        holders.get(row.id) ?? null,
      );
  }

  /**
   * Lapse one task whose lease ran past grace: clear the whole `claim_*` group and set
   * `status='open'` in the same statement (binding review note 3), then record `lapsed`.
   */
  async function lapseTask(tx: Tx, roomId: string, taskId: string): Promise<void> {
    const holder = (
      await tx.query<{ claim_agent_id: string | null }>(
        `SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}`,
        [taskId, roomId],
      )
    ).rows[0];
    if (!holder) return;
    const lapsed = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE id=$1 AND room_id=$2 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}
        RETURNING id, claim_generation`,
        [taskId, roomId],
      )
    ).rows[0];
    if (lapsed)
      await recordEvent(
        tx,
        lapsed.id,
        'lapsed',
        Number(lapsed.claim_generation),
        'system',
        holder.claim_agent_id,
      );
  }

  /** Lapse every past-grace claim in the room (list path), with one `lapsed` event each. */
  async function lapseRoom(tx: Tx, roomId: string): Promise<void> {
    const holders = new Map(
      (
        await tx.query<{ id: string; claim_agent_id: string | null }>(
          `SELECT id,claim_agent_id FROM room_tasks WHERE room_id=$1 AND status='claimed'
            AND claim_expires_at + claim_grace_ms <= ${DBNOW}`,
          [roomId],
        )
      ).rows.map((row) => [row.id, row.claim_agent_id] as const),
    );
    if (!holders.size) return;
    const lapsed = (
      await tx.query<{ id: string; claim_generation: string | number }>(
        `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
          claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
          claim_generation=claim_generation+1, updated_at=${DBNOW}
        WHERE room_id=$1 AND status='claimed'
          AND claim_expires_at + claim_grace_ms <= ${DBNOW}
        RETURNING id, claim_generation`,
        [roomId],
      )
    ).rows;
    for (const row of lapsed)
      await recordEvent(
        tx,
        row.id,
        'lapsed',
        Number(row.claim_generation),
        'system',
        holders.get(row.id) ?? null,
      );
  }

  /** Best-effort acting agent for pre-transaction rate charging (rechecked inside). */
  async function plainAgent(
    q: Pick<Tx, 'query'>,
    roomRef: string,
    operatorId: string,
    agentId: string | undefined,
  ): Promise<string | null> {
    try {
      const room = await findRoom(q, roomRef);
      if (!room) return null;
      const agents = await liveAgents(q, operatorId);
      const members = (
        await q.query<MemberRow>(
          'SELECT agent_id,role FROM room_members WHERE room_id=$1 AND owner_id=$2 AND removed_at IS NULL',
          [room.id, operatorId],
        )
      ).rows.filter((row) => agents.has(row.agent_id));
      if (agentId !== undefined)
        return members.some((row) => row.agent_id === agentId) ? agentId : null;
      return members.length === 1 ? members[0]!.agent_id : null;
    } catch {
      return null;
    }
  }

  async function create(
    p: RoomPrincipal,
    body: unknown,
    options: { precondition?: (tx: Pick<Tx, 'query'>) => Promise<string | null> } = {},
  ) {
    const values = taskCreateInput.parse(body);
    const keyHash = sha(`room-task-create:${values.idempotency_key}`);
    const requestHash = sha(
      canonical({
        title: values.title,
        body: values.body ?? '',
        from: values.from_message_seq ?? null,
        attachments: [...(values.attachment_ids ?? [])].sort(),
      }),
    );
    await d.limit(
      `room-task-create:${p.operatorId}:${values.room_id}`,
      limits.createsPerOwnerPerRoomPerHour,
      HOUR,
    );
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId);
      const agent = actingAgent(members, values.agent_id, actors);
      writeGuards(room, agent);
      // The host muted this owner (migration 35): no task writes either.
      await refuseIfMuted(tx, room.id, p.operatorId);
      const attachmentIds = [...new Set(values.attachment_ids ?? [])];
      await assertAttachmentsReady(tx, room.id, attachmentIds);
      const prior = (
        await tx.query<TaskRow>(
          'SELECT * FROM room_tasks WHERE room_id=$1 AND created_by_owner_id=$2 AND idempotency_key=$3',
          [room.id, p.operatorId, keyHash],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== requestHash)
          refuse(409, 'idempotency_conflict', 'This idempotency_key belongs to a different task.');
        return { task: project(prior), replayed: true };
      }
      // The room row lock serializes number allocation without touching the rooms schema.
      await tx.query('SELECT 1 FROM rooms WHERE id=$1 FOR UPDATE', [room.id]);
      if (options.precondition) {
        const refused = await options.precondition(tx);
        if (refused) refuse(409, refused, 'This task can no longer be created here.');
      }
      const maxNumber = (
        await tx.query<{ n: string | number | null }>(
          'SELECT max(number) AS n FROM room_tasks WHERE room_id=$1',
          [room.id],
        )
      ).rows[0]?.n;
      const row = (
        await tx.query<TaskRow>(
          `INSERT INTO room_tasks(id,room_id,number,title,body,status,created_by_agent_id,
            created_by_owner_id,from_message_seq,attachment_ids,created_at,updated_at,
            idempotency_key,request_hash)
          VALUES($1,$2,$3,$4,$5,'open',$6,$7,$8,$9::text[],${DBNOW},${DBNOW},$10,$11)
          RETURNING *`,
          [
            randomUUID(),
            room.id,
            Number(maxNumber ?? 0) + 1,
            values.title,
            values.body ?? '',
            agent.agent_id,
            p.operatorId,
            values.from_message_seq ?? null,
            attachmentIds,
            keyHash,
            requestHash,
          ],
        )
      ).rows[0]!;
      await recordEvent(
        tx,
        row.id,
        'created',
        Number(row.claim_generation),
        p.actor,
        agent.agent_id,
      );
      await taskLine(
        tx,
        room.id,
        `${await memberLabel(tx, room.id, agent.agent_id)} created ${taskRef(row)}`,
      );
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      return { task: project(row), replayed: false };
    });
  }

  async function get(p: RoomPrincipal, body: unknown) {
    const values = taskGetInput.parse(body);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId);
      if (room.closed_at !== null) await releaseClosedClaims(tx, room);
      else {
        await releaseInvalidHolders(tx, room, values.task_id);
        await lapseTask(tx, room.id, values.task_id);
      }
      const row = (
        await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!row) refuse(404, 'task_not_found', 'Task not found in this room.');
      return { task: project(row!) };
    });
  }

  async function list(p: RoomPrincipal, body: unknown) {
    const values = taskListInput.parse(body);
    const size = Math.min(values.limit ?? limits.defaultPageSize, limits.pageSize);
    return d.db.transaction(async (tx) => {
      const { room, members } = await membership(tx, values.room_id, p.operatorId);
      if (room.closed_at !== null) await releaseClosedClaims(tx, room);
      else {
        await releaseInvalidHolders(tx, room);
        await lapseRoom(tx, room.id);
      }
      const params: unknown[] = [room.id];
      let where = 'room_id=$1';
      if (values.status !== undefined) {
        params.push(values.status);
        where += ` AND status=$${params.length}`;
      }
      if (values.mine === true) {
        params.push(members.map((row) => row.agent_id));
        where += ` AND claim_agent_id = ANY($${params.length}::text[])`;
      }
      params.push(size);
      const rows = (
        await tx.query<TaskRow>(
          `SELECT * FROM room_tasks WHERE ${where} ORDER BY number LIMIT $${params.length}`,
          params,
        )
      ).rows;
      return { room_id: room.id, tasks: rows.map(project) };
    });
  }

  async function claim(p: RoomPrincipal, body: unknown) {
    const values = taskClaimInput.parse(body);
    // Charged before the transaction (pool rule); the agent is rechecked under the lock.
    const probe = await plainAgent(d.db, values.room_id, p.operatorId, values.agent_id);
    await d.limit(`room-task-claim:${probe ?? p.operatorId}`, limits.claimsPerAgentPerHour, HOUR);
    return d.db.transaction(async (tx) => {
      const { room, members, actors } = await membership(tx, values.room_id, p.operatorId);
      const agent = actingAgent(members, values.agent_id, actors);
      writeGuards(room, agent);
      // The host muted this owner (migration 35): no task writes either.
      await refuseIfMuted(tx, room.id, p.operatorId);
      await lockRoom(tx, room.id);
      // A removed or access-expired holder is released first, so this claim can
      // take the task over in its single UPDATE below.
      await releaseInvalidHolders(tx, room, values.task_id);
      // Whether this is a new claim (a line in the thread) or the holder re-issuing (no line).
      const before = (
        await tx.query<{ status: string; claim_agent_id: string | null }>(
          'SELECT status, claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2',
          [values.task_id, room.id],
        )
      ).rows[0];
      const ttlMs = (values.ttl_minutes ?? limits.claimTtlMinutesDefault) * 60_000;
      const graceMs = graceForTtl(ttlMs);
      const token = mintClaimToken();
      // One conditional UPDATE, grace included: open, past grace (takeover), or the
      // holding agent re-issuing (which mints a NEW token, never the old one).
      // Statuses done/cancelled/in_review never match, so a claim can never reopen
      // a closed task; the follow-up SELECT reports those as 409 task_not_claimable.
      const row = (
        await tx.query<TaskRow>(
          `UPDATE room_tasks SET status='claimed', claim_agent_id=$3, claim_owner_id=$4,
            claim_expires_at=${DBNOW}+($5::bigint), claim_ttl_ms=$5, claim_grace_ms=$6,
            claim_token_hash=$7, claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2
            AND status IN ('open','claimed')
            AND (claim_agent_id IS NULL
              OR claim_expires_at + claim_grace_ms <= ${DBNOW}
              OR claim_agent_id=$3)
          RETURNING *`,
          [
            values.task_id,
            room.id,
            agent.agent_id,
            p.operatorId,
            ttlMs,
            graceMs,
            tokenHashOf(token),
          ],
        )
      ).rows[0];
      if (!row) {
        const current = (
          await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
            values.task_id,
            room.id,
          ])
        ).rows[0];
        if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
        if (
          current!.status === 'done' ||
          current!.status === 'cancelled' ||
          current!.status === 'in_review'
        )
          refuse(409, 'task_not_claimable', 'The task is closed and cannot be claimed.', {
            status: current!.status,
          });
        refuse(409, 'task_claimed', 'The task is already claimed.', {
          claimed_by: current!.claim_agent_id,
          expires_at: iso(Number(current!.claim_expires_at)),
          grace_until: iso(Number(current!.claim_expires_at) + Number(current!.claim_grace_ms)),
        });
      }
      await recordEvent(
        tx,
        row!.id,
        'claimed',
        Number(row!.claim_generation),
        p.actor,
        agent.agent_id,
      );
      if (before?.status !== 'claimed' || before.claim_agent_id !== agent.agent_id)
        await taskLine(
          tx,
          room.id,
          `${await memberLabel(tx, room.id, agent.agent_id)} claimed ${taskRef(row!)}`,
        );
      await touchMembers(tx, room.id, [agent.agent_id], d.clock());
      return {
        task: project(row!),
        claim_token: token,
        generation: Number(row!.claim_generation),
        expires_at: iso(Number(row!.claim_expires_at)),
        grace_until: iso(Number(row!.claim_expires_at) + Number(row!.claim_grace_ms)),
      };
    });
  }

  async function renew(p: RoomPrincipal, body: unknown) {
    const values = taskRenewInput.parse(body);
    const hash = tokenHashOf(values.claim_token);
    const holder = await (async () => {
      try {
        const room = await findRoom(d.db, values.room_id);
        if (!room) return null;
        const row = (
          await d.db.query<{ claim_agent_id: string | null }>(
            'SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2 AND claim_token_hash=$3',
            [values.task_id, room.id, hash],
          )
        ).rows[0];
        return row?.claim_agent_id ?? null;
      } catch {
        return null;
      }
    })();
    await d.limit(`room-task-claim:${holder ?? p.operatorId}`, limits.claimsPerAgentPerHour, HOUR);
    try {
      return await d.db.transaction(async (tx) => {
        const { room } = await membership(tx, values.room_id, p.operatorId);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await refuseIfMuted(tx, room.id, p.operatorId);
        await releaseInvalidHolders(tx, room, values.task_id);
        const ttlMs = (values.ttl_minutes ?? limits.claimTtlMinutesDefault) * 60_000;
        const graceMs = graceForTtl(ttlMs);
        // Renewal is explicit only and allowed inside grace. It keeps the token and the
        // generation; the response carries expiries, never a token.
        const row = (
          await tx.query<TaskRow>(
            `UPDATE room_tasks SET claim_expires_at=${DBNOW}+($4::bigint),
              claim_ttl_ms=$4, claim_grace_ms=$5, updated_at=${DBNOW}
            WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3
              AND claim_expires_at + claim_grace_ms > ${DBNOW}
            RETURNING *`,
            [values.task_id, room.id, hash, ttlMs, graceMs],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          stale(current!);
        }
        await recordEvent(
          tx,
          row!.id,
          'renewed',
          Number(row!.claim_generation),
          p.actor,
          row!.claim_agent_id,
        );
        await touchMembers(tx, room.id, [row!.claim_agent_id!], d.clock());
        return {
          task: project(row!),
          expires_at: iso(Number(row!.claim_expires_at)),
          grace_until: iso(Number(row!.claim_expires_at) + Number(row!.claim_grace_ms)),
        };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  async function release(p: RoomPrincipal, body: unknown) {
    const values = taskReleaseInput.parse(body);
    try {
      return await d.db.transaction(async (tx) => {
        const { room } = await membership(tx, values.room_id, p.operatorId);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await releaseInvalidHolders(tx, room, values.task_id);
        const current = (
          await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
            values.task_id,
            room.id,
          ])
        ).rows[0];
        if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
        const clear = `UPDATE room_tasks SET status='open', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}`;
        if (values.claim_token !== undefined) {
          const row = (
            await tx.query<TaskRow>(
              `${clear} WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3 RETURNING *`,
              [values.task_id, room.id, tokenHashOf(values.claim_token)],
            )
          ).rows[0];
          if (!row) stale(current!);
          await recordEvent(
            tx,
            row!.id,
            'released',
            Number(row!.claim_generation),
            p.actor,
            current!.claim_agent_id,
          );
          await touchMembers(tx, room.id, [current!.claim_agent_id!], d.clock());
          return { task: project(row!), released: true };
        }
        // Host force-release (plan §3): no token, host authority only.
        if (room.host_owner_id !== p.operatorId)
          refuse(400, 'claim_token_required', 'Pass the claim token to release this task.');
        if (current!.status !== 'claimed') return { task: project(current!), released: false };
        const row = (
          await tx.query<TaskRow>(
            `${clear} WHERE id=$1 AND room_id=$2 AND status='claimed' RETURNING *`,
            [values.task_id, room.id],
          )
        ).rows[0]!;
        await recordEvent(
          tx,
          row.id,
          'released',
          Number(row.claim_generation),
          p.actor,
          current!.claim_agent_id,
        );
        return { task: project(row), released: true };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  /**
   * Result binding (PR2, plan §6 milestone 2): the current token holder — and only
   * it — attaches step-2 evidence bound to a revision, moving claimed -> in_review.
   * The UPDATE matches the live token inside the lease + grace window (06c, the
   * same window as renew) and clears the whole `claim_*` group in the same
   * statement (CHECK-safe); the old token dies at once. No limiter charge:
   * one result per claim needs no budget.
   */
  async function result(p: RoomPrincipal, body: unknown) {
    const values = taskResultInput.parse(body);
    const hash = tokenHashOf(values.claim_token);
    try {
      return await d.db.transaction(async (tx) => {
        const { room } = await membership(tx, values.room_id, p.operatorId);
        if (room.closed_at !== null)
          refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
        await refuseIfMuted(tx, room.id, p.operatorId);
        await lockRoom(tx, room.id);
        await releaseInvalidHolders(tx, room, values.task_id);
        const holder = (
          await tx.query<{ claim_agent_id: string | null }>(
            'SELECT claim_agent_id FROM room_tasks WHERE id=$1 AND room_id=$2',
            [values.task_id, room.id],
          )
        ).rows[0]?.claim_agent_id;
        // Accepted only inside the lease + grace window (the same window as
        // renew): past grace the token is stale and the write is a 409.
        const row = (
          await tx.query<TaskRow>(
            `UPDATE room_tasks SET status='in_review', result=$4::jsonb,
              claim_agent_id=NULL, claim_owner_id=NULL, claim_expires_at=NULL,
              claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
              claim_generation=claim_generation+1, updated_at=${DBNOW}
            WHERE id=$1 AND room_id=$2 AND status='claimed' AND claim_token_hash=$3
              AND claim_expires_at + claim_grace_ms > ${DBNOW}
            RETURNING *`,
            [values.task_id, room.id, hash, JSON.stringify(values.evidence)],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          stale(current!);
        }
        await recordEvent(
          tx,
          row!.id,
          'result_posted',
          Number(row!.claim_generation),
          p.actor,
          holder ?? null,
        );
        await taskLine(
          tx,
          room.id,
          `${await memberLabel(tx, room.id, holder)} submitted a result for ${taskRef(row!)}`,
        );
        if (holder) await touchMembers(tx, room.id, [holder], d.clock());
        return { task: project(row!) };
      });
    } catch (error) {
      if (error instanceof TaskError && error.errorCode === 'claim_stale')
        await auditStale(values.room_id, values.task_id, p);
      throw error;
    }
  }

  /**
   * Review and cancel (PR2): the host — and only the host — approves an in_review
   * task to done, rejects it back to open (clearing the evidence for a fresh
   * attempt), or cancels an open/claimed/in_review task. Closed rooms are
   * read-only, so review refuses there; done is terminal (409) and an already
   * cancelled task reports `applied: false`, mirroring release.
   */
  async function update(p: RoomPrincipal, body: unknown) {
    const values = taskUpdateInput.parse(body);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId);
      if (room.closed_at !== null)
        refuse(409, 'room_closed', 'The room is closed; its tasks are read-only.');
      if (room.host_owner_id !== p.operatorId)
        refuse(403, 'host_required', 'Only the room host can review or cancel tasks.');
      await lockRoom(tx, room.id);
      if (values.decision === 'approve' || values.decision === 'reject') {
        // Read the posted evidence first: reject clears it from the task but
        // keeps a copy in the `rejected` event payload, marked
        // `untrusted: true` (PR3: kept evidence is another owner's agent text).
        const pending =
          values.decision === 'reject'
            ? ((
                await tx.query<{ result: unknown }>(
                  'SELECT result FROM room_tasks WHERE id=$1 AND room_id=$2',
                  [values.task_id, room.id],
                )
              ).rows[0]?.result ?? null)
            : null;
        const row = (
          await tx.query<TaskRow>(
            values.decision === 'approve'
              ? `UPDATE room_tasks SET status='done',
                  claim_generation=claim_generation+1, updated_at=${DBNOW}
                WHERE id=$1 AND room_id=$2 AND status='in_review' RETURNING *`
              : `UPDATE room_tasks SET status='open', result=NULL,
                  claim_generation=claim_generation+1, updated_at=${DBNOW}
                WHERE id=$1 AND room_id=$2 AND status='in_review' RETURNING *`,
            [values.task_id, room.id],
          )
        ).rows[0];
        if (!row) {
          const current = (
            await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
              values.task_id,
              room.id,
            ])
          ).rows[0];
          if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
          refuse(409, 'task_not_in_review', 'Only tasks in review can be approved or rejected.', {
            status: current!.status,
          });
        }
        await recordEvent(
          tx,
          row!.id,
          values.decision === 'approve' ? 'approved' : 'rejected',
          Number(row!.claim_generation),
          p.actor,
          null,
          values.decision === 'reject' ? { evidence: pending, untrusted: true } : undefined,
        );
        await taskLine(
          tx,
          room.id,
          values.decision === 'approve'
            ? `The host accepted ${taskRef(row!)}`
            : `The host sent back ${taskRef(row!)}`,
        );
        return { task: project(row!), decision: values.decision, applied: true as const };
      }
      const current = (
        await tx.query<TaskRow>('SELECT * FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!current) refuse(404, 'task_not_found', 'Task not found in this room.');
      if (current!.status === 'cancelled')
        return { task: project(current!), decision: values.decision, applied: false as const };
      if (current!.status === 'done')
        refuse(409, 'task_closed', 'The task is done and cannot be cancelled.', {
          status: current!.status,
        });
      // Cancel keeps the posted evidence (if any) for the audit trail and clears the
      // claim group CHECK-safely when one is held.
      const row = (
        await tx.query<TaskRow>(
          `UPDATE room_tasks SET status='cancelled', claim_agent_id=NULL, claim_owner_id=NULL,
            claim_expires_at=NULL, claim_ttl_ms=NULL, claim_grace_ms=NULL, claim_token_hash=NULL,
            claim_generation=claim_generation+1, updated_at=${DBNOW}
          WHERE id=$1 AND room_id=$2 AND status IN ('open','claimed','in_review')
          RETURNING *`,
          [values.task_id, room.id],
        )
      ).rows[0]!;
      await recordEvent(
        tx,
        row.id,
        'cancelled',
        Number(row.claim_generation),
        p.actor,
        current!.claim_agent_id,
      );
      await taskLine(tx, room.id, `The host cancelled ${taskRef(row)}`);
      return { task: project(row), decision: values.decision, applied: true as const };
    });
  }

  async function events(p: RoomPrincipal, body: unknown) {
    const values = taskEventsInput.parse(body);
    const size = Math.min(values.limit ?? limits.defaultPageSize, limits.pageSize);
    return d.db.transaction(async (tx) => {
      const { room } = await membership(tx, values.room_id, p.operatorId);
      const task = (
        await tx.query<{ id: string }>('SELECT id FROM room_tasks WHERE id=$1 AND room_id=$2', [
          values.task_id,
          room.id,
        ])
      ).rows[0];
      if (!task) refuse(404, 'task_not_found', 'Task not found in this room.');
      let since: number | null = null;
      let sinceId = '';
      if (values.after_id !== undefined) {
        const cursor = (
          await tx.query<{ created_at: string | number; id: string }>(
            'SELECT created_at,id FROM room_task_events WHERE id=$1 AND task_id=$2',
            [values.after_id, values.task_id],
          )
        ).rows[0];
        if (!cursor) refuse(400, 'unknown_cursor', 'The page cursor is unknown; start over.');
        since = Number(cursor!.created_at);
        sinceId = cursor!.id;
      }
      const rows = (
        await tx.query<TaskEventRow>(
          `SELECT * FROM room_task_events WHERE task_id=$1
            AND ($2::bigint IS NULL OR created_at > $2::bigint
              OR (created_at = $2::bigint AND id > $3::text))
            ORDER BY created_at, id LIMIT $4`,
          [values.task_id, since, sinceId, size + 1],
        )
      ).rows;
      const shown = rows.slice(0, size);
      return {
        task_id: values.task_id,
        events: shown.map(projectEvent),
        next_after: shown.length ? shown.at(-1)!.id : null,
        has_more: rows.length > size,
      };
    });
  }

  return scopedByPrincipal({
    create,
    get,
    list,
    claim,
    renew,
    release,
    result,
    update,
    events,
    limits,
  });
}
