import { randomBytes, randomUUID } from 'node:crypto';
import type { Transaction as Tx } from '../database.js';

/**
 * The hosted responder as a wake target (migration 26; docs/RESPONDER.md): one
 * `wake_webhooks` row per agent with kind 'responder', events ['mention'] and no URL. On means
 * `disabled_at IS NULL`; off and every pause set `disabled_at` and delete the target's pending
 * outbox row in the same transaction (review B1: disabled targets never hold claim slots).
 */
export async function setResponderTarget(
  tx: Pick<Tx, 'query'>,
  target: { agentId: string; ownerId: string; on: boolean; time: number; actor: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by,kind,disabled_at)
     VALUES($1,$2,$3,NULL,ARRAY['mention'],$4,$5,$6,'responder',$7)
     ON CONFLICT (agent_id, kind) DO UPDATE SET owner_id=EXCLUDED.owner_id,
       disabled_at=EXCLUDED.disabled_at, consecutive_failures=0`,
    [
      randomUUID(),
      target.agentId,
      target.ownerId,
      randomBytes(16).toString('base64url'),
      target.time,
      target.actor,
      target.on ? null : target.time,
    ],
  );
  if (!target.on)
    await tx.query(
      `DELETE FROM wake_outbox WHERE webhook_id IN (
         SELECT id FROM wake_webhooks WHERE agent_id=$1 AND kind='responder')`,
      [target.agentId],
    );
}

/** Turns the targets of these agents off (revocation, ownership change). */
export async function disableResponderTargets(
  tx: Pick<Tx, 'query'>,
  agentIds: readonly string[] | null,
  ownerId: string,
  time: number,
): Promise<void> {
  const agents = agentIds ? [...agentIds] : null;
  await tx.query(
    `DELETE FROM wake_outbox WHERE webhook_id IN (
       SELECT id FROM wake_webhooks WHERE kind='responder' AND owner_id=$1
         AND ($2::text[] IS NULL OR agent_id = ANY($2::text[])))`,
    [ownerId, agents],
  );
  await tx.query(
    `UPDATE wake_webhooks SET disabled_at=$3 WHERE kind='responder' AND owner_id=$1
       AND ($2::text[] IS NULL OR agent_id = ANY($2::text[])) AND disabled_at IS NULL`,
    [ownerId, agents, time],
  );
}
