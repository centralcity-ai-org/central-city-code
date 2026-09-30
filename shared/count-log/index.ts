/*
 * RFC 6962 Merkle log for Central City's public agent count: leaves, tree, proofs and daily
 * checkpoints; see the verifier README. Pure and dependency-free: it runs unchanged on the
 * server, in the browser verifier on /downtown/verify and in the CLI. SHA-256 and Ed25519 come
 * from Web Crypto (globalThis.crypto.subtle), present in browsers and Node 22+.
 *
 * Hashing follows RFC 6962 (Certificate Transparency): leaf = H(0x00 ‖ data),
 * node = H(0x01 ‖ left ‖ right), with the same split rule for any tree size, so the inclusion and
 * consistency proofs are the standard ones.
 */

export const LEAF_CONTEXT = 'cc-agent-leaf/v1';
/** Signing context: a checkpoint signature can never be confused with an Agent Card JWS. */
export const CHECKPOINT_SIGNING_CONTEXT = 'centralcity:agent-count-checkpoint:v1';
export const CHECKPOINT_VERSION = 1;

const encoder = new TextEncoder();
const subtle = () => {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error('Web Crypto is not available.');
  return value;
};

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', data as BufferSource));
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) throw new Error('Invalid hex.');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** RFC 6962 leaf hash over arbitrary data. */
export const hashLeaf = (data: Uint8Array) => sha256(concat(Uint8Array.of(0), data));
/** RFC 6962 interior node hash. */
export const hashNode = (left: Uint8Array, right: Uint8Array) =>
  sha256(concat(Uint8Array.of(1), left, right));

/** A day in UTC, YYYY-MM-DD (the only time granularity that is ever public). */
export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The public leaf for one counted agent. The salt (32 random bytes, server-side, revealed only
 * to the agent's owner in a proof) makes the leaf unguessable from the agent id.
 */
export async function agentLeafHash(
  agentId: string,
  salt: Uint8Array,
  createdDay: string,
): Promise<Uint8Array> {
  if (salt.length !== 32) throw new Error('The salt must be 32 bytes.');
  if (!isDay(createdDay)) throw new Error('The day must be YYYY-MM-DD.');
  const id = encoder.encode(agentId);
  const day = encoder.encode(createdDay);
  // Length-prefixed fields: no two different (id, day) pairs share an encoding.
  const len = (n: number) => Uint8Array.of((n >>> 8) & 0xff, n & 0xff);
  return hashLeaf(
    concat(encoder.encode(LEAF_CONTEXT), len(id.length), id, salt, len(day.length), day),
  );
}

/** Largest power of two strictly less than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** Merkle Tree Hash (RFC 6962 §2.1) over already-hashed leaves. Iterative over levels. */
export async function merkleRoot(leaves: readonly Uint8Array[]): Promise<Uint8Array> {
  if (!leaves.length) return sha256(new Uint8Array());
  return subtreeRoot(leaves, 0, leaves.length);
}

/**
 * Root of leaves[start, start+size). Levels are combined pairwise left to right, carrying an
 * odd last node up unchanged: for RFC 6962 trees this equals the recursive definition.
 */
async function subtreeRoot(
  leaves: readonly Uint8Array[],
  start: number,
  size: number,
): Promise<Uint8Array> {
  let level = leaves.slice(start, start + size);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2)
      next.push(await hashNode(level[i]!, level[i + 1]!));
    if (level.length % 2) next.push(level[level.length - 1]!);
    level = next;
  }
  return level[0]!;
}

/** Audit path for leaf m in a tree of the given leaves (RFC 6962 §2.1.1 PATH). */
export async function inclusionProof(
  leaves: readonly Uint8Array[],
  m: number,
): Promise<Uint8Array[]> {
  if (!Number.isInteger(m) || m < 0 || m >= leaves.length) throw new Error('Leaf out of range.');
  const path: Uint8Array[] = [];
  let start = 0;
  let n = leaves.length;
  let index = m;
  const stack: Uint8Array[] = [];
  while (n > 1) {
    const k = split(n);
    if (index < k) {
      stack.push(await subtreeRoot(leaves, start + k, n - k));
      n = k;
    } else {
      stack.push(await subtreeRoot(leaves, start, k));
      start += k;
      index -= k;
      n -= k;
    }
  }
  // PATH lists siblings from the leaf upwards.
  for (let i = stack.length - 1; i >= 0; i--) path.push(stack[i]!);
  return path;
}

/**
 * Every level of the tree, bottom (the leaves) to top (the root), built pairwise with an odd last
 * node carried up unchanged. For RFC 6962 trees this is the same tree as the recursive definition,
 * so paths read from it equal `inclusionProof`. Built once per checkpoint, it answers any number
 * of proofs without rehashing (2n − 1 nodes in memory).
 */
export async function treeLevels(leaves: readonly Uint8Array[]): Promise<Uint8Array[][]> {
  const levels: Uint8Array[][] = [[...leaves]];
  while (levels.at(-1)!.length > 1) {
    const level = levels.at(-1)!;
    const next: Uint8Array[] = [];
    for (let i = 0; i + 1 < level.length; i += 2)
      next.push(await hashNode(level[i]!, level[i + 1]!));
    if (level.length % 2) next.push(level[level.length - 1]!);
    levels.push(next);
  }
  return levels;
}

/** The audit path for leaf m, read from precomputed levels (no hashing). */
export function inclusionProofFromLevels(levels: readonly Uint8Array[][], m: number): Uint8Array[] {
  const size = levels[0]?.length ?? 0;
  if (!Number.isInteger(m) || m < 0 || m >= size) throw new Error('Leaf out of range.');
  const path: Uint8Array[] = [];
  let index = m;
  for (let depth = 0; depth < levels.length - 1; depth++) {
    const level = levels[depth]!;
    const sibling = index ^ 1;
    // An odd last node has no sibling here: it is carried up unchanged.
    if (sibling < level.length) path.push(level[sibling]!);
    index = Math.floor(index / 2);
  }
  return path;
}

/** Verifies an inclusion proof (RFC 9162 §2.1.3.2 algorithm). */
export async function verifyInclusion(
  leafHash: Uint8Array,
  index: number,
  treeSize: number,
  path: readonly Uint8Array[],
  root: Uint8Array,
): Promise<boolean> {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize) || index < 0 || index >= treeSize)
    return false;
  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of path) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = await hashNode(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else r = await hashNode(r, p);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equalBytes(r, root);
}

/** Consistency proof between tree sizes m and n (RFC 6962 §2.1.2 PROOF). */
export async function consistencyProof(
  leaves: readonly Uint8Array[],
  m: number,
): Promise<Uint8Array[]> {
  const n = leaves.length;
  if (!Number.isInteger(m) || m < 0 || m > n) throw new Error('Old size out of range.');
  if (m === 0 || m === n) return [];
  const out: Uint8Array[] = [];
  // Iterative SUBPROOF(m, D[start:start+size], b).
  let start = 0;
  let size = n;
  let mm = m;
  let complete = true;
  const trail: Uint8Array[] = [];
  while (true) {
    if (mm === size) {
      if (!complete) trail.push(await subtreeRoot(leaves, start, size));
      break;
    }
    const k = split(size);
    if (mm <= k) {
      trail.push(await subtreeRoot(leaves, start + k, size - k));
      size = k;
    } else {
      trail.push(await subtreeRoot(leaves, start, k));
      start += k;
      size -= k;
      mm -= k;
      complete = false;
    }
  }
  // The recursion appends the deepest node first, then the siblings on the way back up.
  out.push(trail[trail.length - 1]!);
  for (let i = trail.length - 2; i >= 0; i--) out.push(trail[i]!);
  return trail.length ? out : [];
}

/** Verifies a consistency proof (RFC 9162 §2.1.4.2 algorithm). */
export async function verifyConsistency(
  oldSize: number,
  newSize: number,
  oldRoot: Uint8Array,
  newRoot: Uint8Array,
  proof: readonly Uint8Array[],
): Promise<boolean> {
  if (oldSize < 0 || newSize < oldSize) return false;
  if (oldSize === newSize) return proof.length === 0 && equalBytes(oldRoot, newRoot);
  if (oldSize === 0) return proof.length === 0;
  if (!proof.length) return false;
  const path = [...proof];
  if ((oldSize & (oldSize - 1)) === 0) path.unshift(oldRoot);
  if (!path.length) return false;
  let fn = oldSize - 1;
  let sn = newSize - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      fr = await hashNode(c, fr);
      sr = await hashNode(c, sr);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else sr = await hashNode(sr, c);
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equalBytes(fr, oldRoot) && equalBytes(sr, newRoot);
}

export interface Subcounts {
  in_person_accounts: number;
  in_ai_workspaces: number;
  unclaimed: number;
  revoked: number;
}

/** The public checkpoint (one per UTC day), before its hash and signature. */
export interface CheckpointBody {
  v: 1;
  date: string;
  tree_size: number;
  withdrawn: number;
  root: string;
  prev_hash: string | null;
  subcounts: Subcounts;
}

export interface Checkpoint extends CheckpointBody {
  /** SHA-256 of the canonical body, hex. */
  hash: string;
  /** Ed25519 over CHECKPOINT_SIGNING_CONTEXT ‖ "\n" ‖ hash, base64url; kid names the JWKS key. */
  signature: { kid: string; sig: string } | null;
  /** RFC 6962 consistency proof from the previous checkpoint's tree, hex nodes. */
  consistency: string[];
}

/** Canonical JSON: fixed key order, no whitespace. */
export function canonicalCheckpoint(body: CheckpointBody): string {
  const s = body.subcounts;
  return JSON.stringify({
    v: body.v,
    date: body.date,
    tree_size: body.tree_size,
    withdrawn: body.withdrawn,
    root: body.root,
    prev_hash: body.prev_hash,
    subcounts: {
      in_person_accounts: s.in_person_accounts,
      in_ai_workspaces: s.in_ai_workspaces,
      unclaimed: s.unclaimed,
      revoked: s.revoked,
    },
  });
}

export async function checkpointHash(body: CheckpointBody): Promise<string> {
  return toHex(await sha256(encoder.encode(canonicalCheckpoint(body))));
}

/** The exact bytes a checkpoint signature covers (domain-separated). */
export function checkpointSigningInput(hash: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('Invalid checkpoint hash.');
  return encoder.encode(`${CHECKPOINT_SIGNING_CONTEXT}\n${hash}`);
}

const b64url = {
  decode(value: string): Uint8Array {
    const base = value.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(base + '='.repeat((4 - (base.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

/** Verifies a checkpoint signature with a public Ed25519 JWK (from /.well-known/jwks.json). */
export async function verifyCheckpointSignature(
  hash: string,
  sig: string,
  jwk: { kty: string; crv: string; x: string },
): Promise<boolean> {
  try {
    const key = await subtle().importKey(
      'jwk',
      { kty: jwk.kty, crv: jwk.crv, x: jwk.x } as JsonWebKey,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    return await subtle().verify(
      { name: 'Ed25519' },
      key,
      b64url.decode(sig) as BufferSource,
      checkpointSigningInput(hash) as BufferSource,
    );
  } catch {
    return false;
  }
}

export type ChainProblem = { date: string; problem: string };

/**
 * Checks a list of checkpoints (oldest first): each hash is its body's hash, each prev_hash
 * links to the previous hash, sizes never shrink, withdrawn never shrinks, sub-counts add up,
 * and each consistency proof shows the new tree extends the old one.
 */
export async function verifyChain(checkpoints: readonly Checkpoint[]): Promise<ChainProblem[]> {
  const problems: ChainProblem[] = [];
  let previous: Checkpoint | null = null;
  for (const cp of checkpoints) {
    const { hash: _h, signature: _s, consistency: _c, ...body } = cp;
    if ((await checkpointHash(body)) !== cp.hash)
      problems.push({ date: cp.date, problem: 'hash does not match the checkpoint' });
    const s = cp.subcounts;
    if (s.in_person_accounts + s.in_ai_workspaces + s.unclaimed !== cp.tree_size - cp.withdrawn)
      problems.push({ date: cp.date, problem: 'sub-counts do not add up' });
    if (previous) {
      if (cp.prev_hash !== previous.hash)
        problems.push({ date: cp.date, problem: 'does not link to the previous checkpoint' });
      if (cp.date <= previous.date) problems.push({ date: cp.date, problem: 'dates out of order' });
      if (cp.tree_size < previous.tree_size)
        problems.push({ date: cp.date, problem: 'the log shrank' });
      if (cp.withdrawn < previous.withdrawn)
        problems.push({ date: cp.date, problem: 'the withdrawn list shrank' });
      const ok = await verifyConsistency(
        previous.tree_size,
        cp.tree_size,
        fromHex(previous.root),
        fromHex(cp.root),
        cp.consistency.map(fromHex),
      );
      if (!ok) problems.push({ date: cp.date, problem: 'not an append-only extension' });
    } else if (cp.prev_hash !== null)
      problems.push({ date: cp.date, problem: 'the first checkpoint must have no previous hash' });
    previous = cp;
  }
  return problems;
}

/** Everything an owner needs to check one agent (from GET /api/agents/:id/count-proof). */
export interface AgentProof {
  idx: number;
  salt: string;
  created_day: string;
  checkpoint_date: string;
  tree_size: number;
  audit_path: string[];
}

/** Recomputes the agent's leaf from its id and proof, and checks it against a checkpoint. */
export async function verifyAgentProof(
  agentId: string,
  proof: AgentProof,
  checkpoint: Pick<Checkpoint, 'date' | 'tree_size' | 'root'>,
): Promise<{ ok: true } | { ok: false; step: string }> {
  if (proof.checkpoint_date !== checkpoint.date || proof.tree_size !== checkpoint.tree_size)
    return { ok: false, step: 'the proof is for a different checkpoint' };
  let leaf: Uint8Array;
  try {
    leaf = await agentLeafHash(agentId, fromHex(proof.salt), proof.created_day);
  } catch {
    return { ok: false, step: 'the leaf could not be recomputed' };
  }
  const ok = await verifyInclusion(
    leaf,
    proof.idx,
    proof.tree_size,
    proof.audit_path.map(fromHex),
    fromHex(checkpoint.root),
  );
  return ok ? { ok: true } : { ok: false, step: 'the path does not lead to the published root' };
}
