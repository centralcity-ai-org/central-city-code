import type { Transaction as Tx } from '../database.js';
import './schema.js';
import { disableResponderTargets } from './targets.js';

/**
 * Revokes stored responder keys and turns auto-reply off when agents change owner or an AI
 * workspace gets a human co-owner. The encryption AAD binds owner_id, so a key
 * must never follow an agent to another owner: the new owner sets auto-reply up again. Runs inside
 * the caller's transaction; a no-op when nothing is stored.
 */
export async function revokeResponderCredentials(
  tx: Pick<Tx, 'query'>,
  scope: { ownerId: string; agentIds?: readonly string[] },
  time: number,
  actor: string,
): Promise<number> {
  const agents = scope.agentIds ? [...scope.agentIds] : null;
  const revoked = await tx.query(
    `UPDATE responder_credentials SET status='revoked', ciphertext=NULL, wrapped_dek=NULL,
       kek_id=NULL, revoked_at=$3, revoked_by=$4
     WHERE owner_id=$1 AND ($2::text[] IS NULL OR agent_id = ANY($2::text[])) AND status <> 'revoked'
     RETURNING id`,
    [scope.ownerId, agents, time, actor],
  );
  await tx.query(
    `UPDATE responder_settings SET enabled=false, status='paused', pause_reason='key_removed',
       updated_at=$3, updated_by=$4
     WHERE owner_id=$1 AND ($2::text[] IS NULL OR agent_id = ANY($2::text[]))
       AND (enabled OR pause_reason IS DISTINCT FROM 'key_removed')`,
    [scope.ownerId, agents, time, actor],
  );
  await disableResponderTargets(tx, agents, scope.ownerId, time);
  return revoked.rows.length;
}
