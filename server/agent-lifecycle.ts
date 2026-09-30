import { createHash, randomBytes } from 'node:crypto';
import type { Transaction as Tx } from './database.js';
import { resetPresence } from './presence.js';
import { revokeAgentCrossConnections } from './connections/service.js';
import { revokeAgentResults } from './results/store.js';
import { revokeResponderCredentials } from './responder/revoke.js';
import { active, event, iso, stopJob, type StoredAgent, type Workspace } from './model.js';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Agents below `rootId` in the parentAgentId lineage, in breadth-first order (root excluded). */
export function descendants(workspace: Workspace, rootId: string): StoredAgent[] {
  const out: StoredAgent[] = [];
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const parent = queue.shift()!;
    for (const agent of workspace.agents)
      if (agent.parentAgentId === parent && !seen.has(agent.id)) {
        seen.add(agent.id);
        out.push(agent);
        queue.push(agent.id);
      }
  }
  return out;
}

/**
 * Revokes one agent inside the owner's workspace transaction: its runtime credential and any
 * pending enrollment codes are deleted and its active work is stopped. Idempotent.
 */
export async function revokeStoredAgent(
  workspace: Workspace,
  tx: Tx,
  operatorId: string,
  agent: StoredAgent,
  time: number,
  message = `${agent.name} revoked.`,
): Promise<boolean> {
  if (agent.revokedAt) return false;
  agent.revokedAt = iso(time);
  agent.announcedOnline = false;
  await tx.query('DELETE FROM credentials WHERE agent_id=$1 AND operator_id=$2', [
    agent.id,
    operatorId,
  ]);
  await tx.query('DELETE FROM runtime_enrollments WHERE agent_id=$1', [agent.id]);
  // Its cross-workspace connections and pending requests end with it (docs/AI_WORKSPACES.md);
  // work it requested in other workspaces then stops on their next read.
  await revokeAgentCrossConnections(tx, operatorId, agent.id, time);
  // Its published results are revoked (content erased) in the same transaction.
  await revokeAgentResults(tx, operatorId, agent.id, time);
  // Its stored responder key is deleted and auto-reply turned off (data minimization).
  await revokeResponderCredentials(
    tx,
    { ownerId: operatorId, agentIds: [agent.id] },
    time,
    'agent revoked',
  );
  for (const job of workspace.jobs)
    if (job.requesterId === agent.id || job.providerId === agent.id)
      stopJob(workspace, job, time, 'Work stopped because an agent was revoked.');
  event(workspace, time, 'agent.revoked', message, agent.id);
  return true;
}

/**
 * Replaces an external agent's runtime credential (owner rotation or runtime enrollment) in the
 * same transaction as presence reset, replay-nonce cleanup and cancellation of its active work.
 * Returns the new one-time credential; only its hash is stored.
 */
export async function issueRuntimeCredential(
  workspace: Workspace,
  tx: Tx,
  operatorId: string,
  agent: StoredAgent,
  time: number,
  reason: 'rotated' | 'enrolled',
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  // The legacy table permits exactly one credential per stable agent identity.
  await tx.query('DELETE FROM credentials WHERE agent_id=$1 AND operator_id=$2', [
    agent.id,
    operatorId,
  ]);
  await tx.query('INSERT INTO credentials(token_hash,operator_id,agent_id) VALUES($1,$2,$3)', [
    sha(token),
    operatorId,
    agent.id,
  ]);
  await tx.query('DELETE FROM replay_nonces WHERE agent_id=$1', [agent.id]);
  await resetPresence(tx, agent.id);
  agent.lastSeenAt = null;
  agent.lastSequence = -1;
  agent.announcedOnline = false;
  for (const job of workspace.jobs) {
    if (active(job) && (job.requesterId === agent.id || job.providerId === agent.id)) {
      stopJob(
        workspace,
        job,
        time,
        reason === 'rotated'
          ? 'Work stopped because an agent credential was rotated.'
          : 'Work stopped because the agent runtime enrolled a new credential.',
      );
      job.leaseHash = null;
    }
  }
  if (reason === 'rotated')
    event(
      workspace,
      time,
      'agent.credential_rotated',
      `${agent.name} runtime credential replaced. Reconnect with the new credential.`,
      agent.id,
    );
  else
    event(
      workspace,
      time,
      'agent.enrolled',
      `${agent.name} runtime enrolled with a single-use code and received its credential.`,
      agent.id,
    );
  return token;
}
