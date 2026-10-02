import { randomUUID } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import { elricEligibility, elricRoomAccess } from './access.js';
import { argsHash } from './turns.js';

/**
 * Pending actions (docs/ELRIC.md; THREAT_PRIVACY_REVIEW §10.5): a consequential tool call is
 * never executed from model output. The server stores the exact arguments and their hash with an
 * expiry; only the owner's console session may approve it, naming the id and the hash it was
 * shown; approval executes the STORED arguments, never anything re-read from the model. The
 * consequential tool today is `room_task_create` (tools.ts CONSEQUENTIAL_TOOLS).
 */
export type ElricPrincipal =
  | { kind: 'owner_session'; operatorId: string }
  | { kind: 'model' }
  | { kind: 'agent'; operatorId: string; agentId: string }
  | { kind: 'grant'; operatorId: string; grantId: string }
  | { kind: 'guest' };

export interface PendingAction {
  id: string;
  owner_id: string;
  agent_id: string;
  room_id: string;
  tool: string;
  args: Record<string, unknown>;
  args_hash: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'failed';
  expires_at: number;
}

/** Runs inside the approval transaction, after the recheck under the room lock. */
export type PendingExecutor = (action: PendingAction, tx: Pick<Tx, 'query'>) => Promise<unknown>;

/**
 * For an action whose execution needs its own transaction (a room task is created by the tasks
 * service under its own room lock). Approval first claims the action in the approval transaction
 * (after the same checks), then `run` executes the stored arguments; `precondition` rechecks the
 * owner's eligibility and Elric's agent-bound access inside that transaction, under the locks,
 * and answers a refusal code or null. A failure marks the action 'failed'.
 */
export interface PendingRunner {
  run(
    action: PendingAction,
    precondition: (tx: Pick<Tx, 'query'>) => Promise<string | null>,
  ): Promise<unknown>;
}
const isRunner = (value: PendingExecutor | PendingRunner): value is PendingRunner =>
  typeof value === 'object' && value !== null && 'run' in value;

/** The recheck an approved action runs under: eligible owner, active Elric in the room. */
async function stillAllowed(
  tx: Pick<Tx, 'query'>,
  operatorId: string,
  row: Pick<PendingAction, 'agent_id' | 'room_id'>,
): Promise<string | null> {
  const eligible = await elricEligibility(tx, operatorId);
  if (!eligible.eligible) return 'elric_unavailable';
  const access = await elricRoomAccess(tx, row.agent_id, row.room_id, {
    mode: 'write',
    lock: true,
  });
  return access.ok ? null : 'elric_unavailable';
}

export class PendingActionError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorCode:
      | 'owner_session_required'
      | 'not_found'
      | 'not_pending'
      | 'expired'
      | 'hash_mismatch'
      | 'no_executor'
      | 'elric_unavailable'
      | 'execution_failed',
  ) {
    super(errorCode);
  }
}

type Row = Omit<PendingAction, 'expires_at'> & { expires_at: string | number };
const view = (row: Row): PendingAction => ({ ...row, expires_at: Number(row.expires_at) });

export async function createPendingAction(
  q: Pick<Tx, 'query'>,
  input: {
    ownerId: string;
    agentId: string;
    roomId: string;
    tool: string;
    args: Record<string, unknown>;
  },
  time: number,
  ttlMs: number,
): Promise<PendingAction> {
  const row = (
    await q.query<Row>(
      `INSERT INTO elric_pending_actions(id,owner_id,agent_id,room_id,tool,args,args_hash,status,
         expires_at,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,'pending',$8,$9) RETURNING *`,
      [
        randomUUID(),
        input.ownerId,
        input.agentId,
        input.roomId,
        input.tool,
        JSON.stringify(input.args),
        argsHash(input.args),
        time + ttlMs,
        time,
      ],
    )
  ).rows[0]!;
  return view(row);
}

function requireOwnerSession(principal: ElricPrincipal): string {
  if (principal.kind !== 'owner_session')
    throw new PendingActionError(403, 'owner_session_required');
  return principal.operatorId;
}

/**
 * Approves and executes a pending action in ONE transaction: the row lock (FOR UPDATE) makes two
 * approvals never both execute; before executing, the owner's eligibility and Elric's agent-bound
 * access to the action's room are rechecked under the Elric row and room locks (a paused,
 * revoked or removed Elric executes nothing); the executor gets the STORED arguments. A foreign id
 * answers not_found.
 */
export async function approvePendingAction(
  db: Pick<Database, 'query' | 'transaction'>,
  principal: ElricPrincipal,
  input: { id: string; argsHash: string },
  executors: Readonly<Record<string, PendingExecutor | PendingRunner>>,
  time: number,
): Promise<{ action: PendingAction; result: unknown }> {
  const operatorId = requireOwnerSession(principal);
  let claimed: PendingAction | null = null;
  try {
    type Decided =
      | { action: PendingAction; result: unknown; runner?: undefined }
      | { action: PendingAction; runner: PendingRunner };
    const decided = await db.transaction(async (tx): Promise<Decided> => {
      const row = (
        await tx.query<Row>(
          'SELECT * FROM elric_pending_actions WHERE id=$1 AND owner_id=$2 FOR UPDATE',
          [input.id, operatorId],
        )
      ).rows[0];
      if (!row) throw new PendingActionError(404, 'not_found');
      if (row.status !== 'pending') throw new PendingActionError(409, 'not_pending');
      if (Number(row.expires_at) <= time) {
        claimed = view(row);
        throw new PendingActionError(409, 'expired');
      }
      // The owner approves exactly what was shown; the stored row must still hash to it.
      if (input.argsHash !== row.args_hash || argsHash(row.args) !== row.args_hash)
        throw new PendingActionError(409, 'hash_mismatch');
      const executor = executors[row.tool];
      if (!executor) throw new PendingActionError(409, 'no_executor');
      if (await stillAllowed(tx, operatorId, row))
        throw new PendingActionError(409, 'elric_unavailable');
      const action = view({ ...row, status: 'approved' });
      claimed = action;
      if (isRunner(executor)) {
        // Claimed now (never executed twice); executed right after this transaction commits.
        await tx.query(
          `UPDATE elric_pending_actions SET status='approved', decided_at=$2, decided_by='the owner'
            WHERE id=$1`,
          [row.id, time],
        );
        return { action, runner: executor };
      }
      const result = await executor(action, tx);
      await tx.query(
        `UPDATE elric_pending_actions SET status='approved', decided_at=$2, decided_by='the owner',
           result=$3::jsonb WHERE id=$1`,
        [row.id, time, JSON.stringify(result ?? null)],
      );
      return { action, result };
    });
    if (!decided.runner) return { action: decided.action, result: decided.result };
    try {
      const result = await decided.runner.run(decided.action, (tx) =>
        stillAllowed(tx, operatorId, decided.action),
      );
      await db.query('UPDATE elric_pending_actions SET result=$2::jsonb WHERE id=$1', [
        decided.action.id,
        JSON.stringify(result ?? null),
      ]);
      return { action: decided.action, result };
    } catch (error) {
      await db.query(
        `UPDATE elric_pending_actions SET status='failed', result=$2::jsonb
          WHERE id=$1 AND status='approved'`,
        [decided.action.id, JSON.stringify({ error: 'execution_failed' })],
      );
      if (error instanceof PendingActionError) throw error;
      throw new PendingActionError(409, 'execution_failed');
    }
  } catch (error) {
    // The transaction rolled back; record the terminal state of an expired or failed action.
    const done = claimed as PendingAction | null;
    if (done && error instanceof PendingActionError && error.errorCode === 'expired')
      await db.query(
        "UPDATE elric_pending_actions SET status='expired', decided_at=$2 WHERE id=$1 AND status='pending'",
        [done.id, time],
      );
    else if (done && !(error instanceof PendingActionError))
      await db.query(
        `UPDATE elric_pending_actions SET status='failed', decided_at=$2, result=$3::jsonb
          WHERE id=$1 AND status='pending'`,
        [done.id, time, JSON.stringify({ error: 'execution_failed' })],
      );
    throw error;
  }
}

export async function rejectPendingAction(
  q: Pick<Tx, 'query'>,
  principal: ElricPrincipal,
  id: string,
  time: number,
): Promise<void> {
  const operatorId = requireOwnerSession(principal);
  const done = await q.query(
    `UPDATE elric_pending_actions SET status='rejected', decided_at=$3, decided_by='the owner'
      WHERE id=$1 AND owner_id=$2 AND status='pending' RETURNING 1`,
    [id, operatorId, time],
  );
  if (!done.rows.length) throw new PendingActionError(404, 'not_found');
}

/** How long an approved action may wait for its execution's result before it counts as failed. */
export const PENDING_EXECUTION_GRACE_MS = 5 * 60_000;

/**
 * An action claimed as approved whose execution never recorded a result (the process stopped
 * between the claim and the task creation) is marked failed after a grace period, so the owner's
 * list never shows "approved" for something that did not happen. It is never re-executed.
 */
export async function sweepStalePendingActions(
  q: Pick<Tx, 'query'>,
  time: number,
): Promise<number> {
  const swept = await q.query(
    `UPDATE elric_pending_actions SET status='failed', result=$2::jsonb
      WHERE status='approved' AND result IS NULL AND decided_at < $1 RETURNING 1`,
    [time - PENDING_EXECUTION_GRACE_MS, JSON.stringify({ error: 'execution_unconfirmed' })],
  );
  return swept.rows.length;
}
