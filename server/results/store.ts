import type { Transaction as Tx } from '../database.js';
import type { Workspace } from '../model.js';

/**
 * Result cascades, each written in the same transaction as its cause. Revocation
 * erases the published content at once: title, parts, sources and method become null and both
 * search texts '', so the generated search vector is empty and the partial GIN index drops the row.
 */
export type RevokedReason = 'unpublish' | 'agent_revoked' | 'room_removed';
/** SET clause of a revocation; the arguments are the parameter numbers of time, actor, reason. */
export const revokeSet = (at: number, by: number, reason: number) =>
  `revoked_at=$${at}, revoked_by=$${by}, revoked_reason=$${reason},
  title=NULL, parts=NULL, sources=NULL, method=NULL, search_body='', search_sources=''`;

/** An agent (and so each agent of its revoked lineage) was revoked: revoke all its results. */
export async function revokeAgentResults(
  tx: Pick<Tx, 'query'>,
  ownerId: string,
  agentId: string,
  time: number,
): Promise<number> {
  const rows = await tx.query(
    `UPDATE published_results SET ${revokeSet(3, 4, 5)}
      WHERE owner_id=$1 AND agent_id=$2 AND revoked_at IS NULL RETURNING id`,
    [ownerId, agentId, time, 'agent revocation', 'agent_revoked'],
  );
  return rows.rows.length;
}

/** A room member was removed: revoke that agent's room results for that room. */
export async function revokeRoomResults(
  tx: Pick<Tx, 'query'>,
  roomId: string,
  agentId: string,
  time: number,
  actor: string,
): Promise<number> {
  const rows = await tx.query(
    `UPDATE published_results SET ${revokeSet(3, 4, 5)}
      WHERE room_id=$1 AND agent_id=$2 AND visibility='room' AND revoked_at IS NULL RETURNING id`,
    [roomId, agentId, time, actor, 'room_removed'],
  );
  return rows.rows.length;
}

/** Pause state that decides result suspension: the workspace and every paused agent. */
export function pauseKey(workspace: Workspace): string {
  return JSON.stringify([
    workspace.paused === true,
    workspace.agents
      .filter((agent) => agent.pausedAt)
      .map((agent) => agent.id)
      .sort(),
  ]);
}

/**
 * Recomputes `suspended_at` of the owner's live results as "workspace paused OR agent paused"
 * (called in the transaction that changed the pause state). Suspended results are hidden from
 * asks, not revoked; resuming restores them.
 */
export async function syncResultSuspension(
  tx: Pick<Tx, 'query'>,
  ownerId: string,
  workspace: Workspace,
  time: number,
): Promise<void> {
  const paused = workspace.agents.filter((agent) => agent.pausedAt).map((agent) => agent.id);
  await tx.query(
    `UPDATE published_results SET suspended_at=CASE WHEN $2::boolean OR agent_id=ANY($3::text[])
        THEN COALESCE(suspended_at,$4) ELSE NULL END
      WHERE owner_id=$1 AND revoked_at IS NULL
        AND (suspended_at IS NULL) = ($2::boolean OR agent_id=ANY($3::text[]))`,
    [ownerId, workspace.paused === true, paused, time],
  );
}
