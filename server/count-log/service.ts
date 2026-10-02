import { randomBytes, sign } from 'node:crypto';
import type { Database, Transaction as Tx } from '../database.js';
import type { SigningKey } from '../manifest/keys.js';
import { pendingFeed, pendingLeaves, type Feed } from './pending.js';
import {
  agentLeafHash,
  checkpointHash,
  checkpointSigningInput,
  consistencyProof,
  inclusionProofFromLevels,
  treeLevels,
  merkleRoot,
  toHex,
  type AgentProof,
  type Checkpoint,
  type CheckpointBody,
  type Subcounts,
} from '../../shared/count-log/index.js';

/*
 * The verifiable agent count. Once a
 * day the checkpoint job appends every newly counted agent as a salted leaf, lists agents that are
 * no longer counted as withdrawn (never erased), and publishes a hash-chained, signed checkpoint
 * with the consistency proof from the previous one. The counting rule is the ticker's
 * (server/stats/public-stats.ts): every agent in any workspace document except the console demo
 * seed (demoKey) and operators listed in CITY_STATS_EXCLUDED_OPERATORS.
 */

/** Serializes checkpoint runs across instances (distinct from the schema lock). */
export const COUNT_LOG_LOCK_KEY = 1128485529;
export const LEAVES_PAGE_MAX = 10_000;

const day = (time: number) => new Date(time).toISOString().slice(0, 10);

/** Current state of every counted agent (one row per agent id). */
const COUNTED_SQL = `SELECT DISTINCT ON (a.value->>'id')
    a.value->>'id' AS agent_id,
    a.value->>'createdAt' AS created_at,
    o.kind AS kind,
    (a.value->>'revokedAt') IS NOT NULL AS revoked
  FROM workspaces w
  JOIN operators o ON o.id = w.operator_id
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
  WHERE a.value->>'demoKey' IS NULL
    AND NOT (w.operator_id = ANY($1::text[]))
  ORDER BY a.value->>'id'`;

type Counted = { agent_id: string; created_at: string | null; kind: string; revoked: boolean };
type CheckpointRow = {
  date: string;
  tree_size: number;
  withdrawn: number;
  root: string;
  prev_hash: string | null;
  hash: string;
  subcounts: Subcounts;
  consistency: string[];
  signature: { kid: string; sig: string } | null;
};

function toCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    v: 1,
    date: row.date,
    tree_size: Number(row.tree_size),
    withdrawn: Number(row.withdrawn),
    root: row.root,
    prev_hash: row.prev_hash,
    subcounts: row.subcounts,
    hash: row.hash,
    signature: row.signature,
    consistency: row.consistency,
  };
}

export interface CountLog {
  /** Runs today's checkpoint (UTC day of the clock); a second run for the same day is a no-op. */
  checkpoint(): Promise<{ checkpoint: Checkpoint; created: boolean }>;
  checkpoints(): Promise<Checkpoint[]>;
  /** The live pending feed (pending.ts), newest first. */
  feed(options: { before?: string; limit?: number }): Promise<Feed>;
  checkpointOn(date: string): Promise<Checkpoint | null>;
  /** Public leaves under the latest checkpoint only, [from, to). */
  leaves(
    from: number,
    to: number,
  ): Promise<{ tree_size: number; leaves: { idx: number; leaf_hash: string; day: string }[] }>;
  withdrawn(): Promise<{ idx: number; reason: string; day: string }[]>;
  /**
   * The owner's proof for one of their own agents, or null when the agent is not theirs (the
   * caller answers 404 for both "not yours" and "does not exist").
   */
  /** The caller's own agents, id and name only (for "Check my agent"; no workspace tick). */
  ownerAgents(operatorId: string): Promise<{ id: string; name: string }[]>;
  ownerProof(
    operatorId: string,
    agentId: string,
  ): Promise<
    | null
    | { pending: true }
    | { pending: false; excluded: 'demo' | 'not_counted' }
    | { pending: false; proof: AgentProof }
  >;
}

export function createCountLog(deps: {
  db: Database;
  clock: () => number;
  excludedOperators?: readonly string[];
  /** The platform signing key; null serves unsigned checkpoints (and says so). */
  signingKey?: SigningKey | null;
}): CountLog {
  const excluded = [...(deps.excludedOperators ?? [])];

  async function allLeafHashes(tx: Pick<Tx, 'query'>, size?: number): Promise<Uint8Array[]> {
    const rows = (
      await tx.query<{ leaf_hash: Uint8Array }>(
        `SELECT leaf_hash FROM count_log_leaves${size === undefined ? '' : ' WHERE idx < $1'} ORDER BY idx`,
        size === undefined ? [] : [size],
      )
    ).rows;
    return rows.map((row) => new Uint8Array(row.leaf_hash));
  }

  async function latest(tx: Pick<Tx, 'query'>): Promise<Checkpoint | null> {
    const row = (
      await tx.query<CheckpointRow>(
        'SELECT * FROM count_log_checkpoints ORDER BY date DESC LIMIT 1',
      )
    ).rows[0];
    return row ? toCheckpoint(row) : null;
  }

  /**
   * The latest checkpoint's tree, built once per checkpoint and instance: an
   * owner proof then reads its path from memory instead of loading and hashing every leaf. The
   * rebuilt root must equal the published one, or no proof is served from it.
   */
  let tree: { date: string; size: number; levels: Uint8Array[][] } | null = null;
  let building: { date: string; promise: Promise<Uint8Array[][]> } | null = null;
  async function levelsFor(checkpoint: Checkpoint): Promise<Uint8Array[][]> {
    if (tree && tree.date === checkpoint.date && tree.size === checkpoint.tree_size)
      return tree.levels;
    if (building?.date !== checkpoint.date) {
      const promise = (async () => {
        const levels = await treeLevels(await allLeafHashes(deps.db, checkpoint.tree_size));
        const root = levels.at(-1)?.[0];
        if (checkpoint.tree_size && (!root || toHex(root) !== checkpoint.root))
          throw new Error('The stored leaves do not match the published checkpoint.');
        tree = { date: checkpoint.date, size: checkpoint.tree_size, levels };
        return levels;
      })().finally(() => {
        building = null;
      });
      building = { date: checkpoint.date, promise };
    }
    return building!.promise;
  }

  function signHash(hash: string): Checkpoint['signature'] {
    const key = deps.signingKey;
    if (!key) return null;
    return {
      kid: key.kid,
      sig: sign(null, checkpointSigningInput(hash), key.privateKey).toString('base64url'),
    };
  }

  return {
    async checkpoint() {
      const now = deps.clock();
      const today = day(now);
      return deps.db.transaction(async (tx) => {
        await tx.query('SELECT pg_advisory_xact_lock($1)', [COUNT_LOG_LOCK_KEY]);
        const existing = (
          await tx.query<CheckpointRow>('SELECT * FROM count_log_checkpoints WHERE date=$1', [
            today,
          ])
        ).rows[0];
        if (existing) return { checkpoint: toCheckpoint(existing), created: false };
        const previous = await latest(tx);
        if (previous && previous.date > today)
          throw new Error('A checkpoint exists for a later day; the clock is behind.');

        const counted = (await tx.query<Counted>(COUNTED_SQL, [excluded])).rows;
        const known = new Map(
          (
            await tx.query<{ idx: number; agent_id: string }>(
              'SELECT idx, agent_id FROM count_log_leaves',
            )
          ).rows.map((row) => [row.agent_id, Number(row.idx)]),
        );
        // 1. Append newly counted agents by creation day and, within a day, in creation order. An
        //    agent recorded in the pending feed (pending.ts) keeps that salt, day and leaf, so the
        //    fingerprint shown as pending is exactly the leaf confirmed here.
        const pending = await pendingLeaves(tx);
        const fresh = counted
          .filter((agent) => !known.has(agent.agent_id))
          .map((agent) => ({
            ...agent,
            created_day:
              pending.get(agent.agent_id)?.created_day ??
              (agent.created_at && !Number.isNaN(Date.parse(agent.created_at))
                ? day(Date.parse(agent.created_at))
                : today),
          }))
          // By day; within a day, agents in the pending feed first, in its creation order
          // (minute, then sequence), so their provisional numbers become their idx; then any
          // others by agent id.
          .sort((a, b) => {
            if (a.created_day !== b.created_day) return a.created_day < b.created_day ? -1 : 1;
            const pa = pending.get(a.agent_id)?.order;
            const pb = pending.get(b.agent_id)?.order;
            if (pa && pb) {
              if (pa[0] !== pb[0]) return pa[0] < pb[0] ? -1 : 1;
              return pa[1] !== pb[1] ? pa[1] - pb[1] : pa[2] - pb[2];
            }
            if (pa || pb) return pa ? -1 : 1;
            return a.agent_id < b.agent_id ? -1 : 1;
          });
        let next = known.size;
        for (const agent of fresh) {
          const recorded = pending.get(agent.agent_id);
          const salt = recorded?.salt ?? randomBytes(32);
          const leaf =
            recorded?.leaf ?? (await agentLeafHash(agent.agent_id, salt, agent.created_day));
          await tx.query(
            'INSERT INTO count_log_leaves(idx,agent_id,salt,created_day,leaf_hash,appended_at) VALUES($1,$2,$3,$4,$5,$6)',
            [next, agent.agent_id, salt, agent.created_day, Buffer.from(leaf), now],
          );
          known.set(agent.agent_id, next++);
        }
        // 2. Leaves whose agent is no longer counted (abuse purge, or an excluded synthetic
        //    account) are listed as withdrawn, never erased.
        const countedIds = new Set(counted.map((agent) => agent.agent_id));
        const withdrawnIdx = new Set(
          (await tx.query<{ idx: number }>('SELECT idx FROM count_log_withdrawn')).rows.map((row) =>
            Number(row.idx),
          ),
        );
        for (const [agentId, idx] of known)
          if (!countedIds.has(agentId) && !withdrawnIdx.has(idx)) {
            await tx.query(
              "INSERT INTO count_log_withdrawn(idx,reason,day,recorded_at) VALUES($1,'no_longer_counted',$2,$3)",
              [idx, today, now],
            );
            withdrawnIdx.add(idx);
          }
        // 3. Sub-counts from current state, over the counted (non-withdrawn) leaves.
        const subcounts: Subcounts = {
          in_person_accounts: 0,
          in_ai_workspaces: 0,
          unclaimed: 0,
          revoked: 0,
        };
        for (const agent of counted) {
          // A withdrawn leaf stays withdrawn even if its agent is counted again later.
          if (withdrawnIdx.has(known.get(agent.agent_id)!)) continue;
          if (agent.kind === 'ai') subcounts.in_ai_workspaces++;
          else if (agent.kind === 'unclaimed') subcounts.unclaimed++;
          else subcounts.in_person_accounts++;
          if (agent.revoked) subcounts.revoked++;
        }
        // 4. The tree, the chain and the proof that it only grew.
        const leaves = await allLeafHashes(tx);
        const body: CheckpointBody = {
          v: 1,
          date: today,
          tree_size: leaves.length,
          withdrawn: withdrawnIdx.size,
          root: toHex(await merkleRoot(leaves)),
          prev_hash: previous?.hash ?? null,
          subcounts,
        };
        const hash = await checkpointHash(body);
        const consistency = previous
          ? (await consistencyProof(leaves, previous.tree_size)).map(toHex)
          : [];
        const checkpoint: Checkpoint = { ...body, hash, signature: signHash(hash), consistency };
        await tx.query(
          `INSERT INTO count_log_checkpoints(date,tree_size,withdrawn,root,prev_hash,hash,subcounts,consistency,signature,created_at)
           VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10)`,
          [
            today,
            body.tree_size,
            body.withdrawn,
            body.root,
            body.prev_hash,
            hash,
            JSON.stringify(subcounts),
            JSON.stringify(consistency),
            checkpoint.signature ? JSON.stringify(checkpoint.signature) : null,
            now,
          ],
        );
        return { checkpoint, created: true };
      });
    },

    async feed(options) {
      return pendingFeed(deps.db, { ...options, excluded });
    },
    async checkpoints() {
      return (
        await deps.db.query<CheckpointRow>('SELECT * FROM count_log_checkpoints ORDER BY date')
      ).rows.map(toCheckpoint);
    },

    async checkpointOn(date) {
      const row = (
        await deps.db.query<CheckpointRow>('SELECT * FROM count_log_checkpoints WHERE date=$1', [
          date,
        ])
      ).rows[0];
      return row ? toCheckpoint(row) : null;
    },

    async leaves(from, to) {
      const size = (await latest(deps.db))?.tree_size ?? 0;
      const end = Math.min(to, size, from + LEAVES_PAGE_MAX);
      if (from >= end) return { tree_size: size, leaves: [] };
      const rows = (
        await deps.db.query<{ idx: number; leaf_hash: Uint8Array; created_day: string }>(
          'SELECT idx, leaf_hash, created_day FROM count_log_leaves WHERE idx >= $1 AND idx < $2 ORDER BY idx',
          [from, end],
        )
      ).rows;
      return {
        tree_size: size,
        leaves: rows.map((row) => ({
          idx: Number(row.idx),
          leaf_hash: toHex(new Uint8Array(row.leaf_hash)),
          day: row.created_day,
        })),
      };
    },

    async withdrawn() {
      return (
        await deps.db.query<{ idx: number; reason: string; day: string }>(
          'SELECT idx, reason, day FROM count_log_withdrawn ORDER BY idx',
        )
      ).rows.map((row) => ({ idx: Number(row.idx), reason: row.reason, day: row.day }));
    },

    async ownerAgents(operatorId) {
      return (
        await deps.db.query<{ id: string; name: string }>(
          `SELECT a.value->>'id' AS id, a.value->>'name' AS name FROM workspaces w
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb))
              WITH ORDINALITY AS a(value, ordinality)
            WHERE w.operator_id=$1 ORDER BY a.ordinality`,
          [operatorId],
        )
      ).rows.map((row) => ({ id: row.id, name: row.name }));
    },

    async ownerProof(operatorId, agentId) {
      // Ownership first: the agent must be in the caller's own workspace document.
      const owned = (
        await deps.db.query<{ demo: boolean }>(
          `SELECT (a.value->>'demoKey') IS NOT NULL AS demo FROM workspaces w
            CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.data->'agents','[]'::jsonb)) AS a(value)
            WHERE w.operator_id=$1 AND a.value->>'id'=$2 LIMIT 1`,
          [operatorId, agentId],
        )
      ).rows[0];
      if (!owned) return null;
      // Agents the count never includes are told so, not promised a later checkpoint.
      if (owned.demo) return { pending: false, excluded: 'demo' };
      if (excluded.includes(operatorId)) return { pending: false, excluded: 'not_counted' };
      const leaf = (
        await deps.db.query<{ idx: number; salt: Uint8Array; created_day: string }>(
          'SELECT idx, salt, created_day FROM count_log_leaves WHERE agent_id=$1',
          [agentId],
        )
      ).rows[0];
      const checkpoint = await latest(deps.db);
      if (!leaf || !checkpoint || Number(leaf.idx) >= checkpoint.tree_size)
        return { pending: true };
      const idx = Number(leaf.idx);
      const levels = await levelsFor(checkpoint);
      return {
        pending: false,
        proof: {
          idx,
          salt: toHex(new Uint8Array(leaf.salt)),
          created_day: leaf.created_day,
          checkpoint_date: checkpoint.date,
          tree_size: checkpoint.tree_size,
          audit_path: inclusionProofFromLevels(levels, idx).map(toHex),
        },
      };
    },
  };
}
