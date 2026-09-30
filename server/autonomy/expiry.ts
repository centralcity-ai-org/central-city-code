import type { Database } from '../database.js';

export const UNCLAIMED_SWEEP_LIMIT = 50;
/** Agent age is never grounds for automatic removal. */
export function unclaimedAgentExpired(_agent: { createdAt: string }, _now: number): boolean {
  return false;
}
/** Compatibility for existing callers. Agents are never deleted because of their age, so there is no expiry sweep, not even for direct callers.
 * This function intentionally performs no database reads or writes. Credential lifetimes are separate.
 */
export async function sweepUnclaimedAgents(
  _db: Database,
  _now: number,
  limit = UNCLAIMED_SWEEP_LIMIT,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > UNCLAIMED_SWEEP_LIMIT)
    throw new Error('Unclaimed sweep limit must be 1-50.');
  return { examined: 0, removed: 0 };
}
