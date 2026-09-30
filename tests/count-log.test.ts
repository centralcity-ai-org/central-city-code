import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  agentLeafHash,
  checkpointHash,
  checkpointSigningInput,
  CHECKPOINT_SIGNING_CONTEXT,
  consistencyProof,
  fromHex,
  hashLeaf,
  inclusionProof,
  inclusionProofFromLevels,
  treeLevels,
  merkleRoot,
  toHex,
  verifyAgentProof,
  verifyChain,
  verifyCheckpointSignature,
  verifyConsistency,
  verifyInclusion,
  type Checkpoint,
  type CheckpointBody,
} from '../shared/count-log/index.js';

const vectors = JSON.parse(
  readFileSync(new URL('../shared/count-log/rfc6962-vectors.json', import.meta.url), 'utf8'),
) as {
  leaves: string[];
  roots: string[];
  paths: Record<string, string[]>;
  cons: Record<string, string[]>;
};

test('RFC 6962 vectors: roots, audit paths and consistency proofs match the reference', async () => {
  const leaves = await Promise.all(vectors.leaves.map((hex) => hashLeaf(fromHex(hex))));
  for (let n = 1; n <= 8; n++) {
    const tree = leaves.slice(0, n);
    const root = await merkleRoot(tree);
    assert.equal(toHex(root), vectors.roots[n - 1], `root ${n}`);
    for (let m = 0; m < n; m++) {
      const path = await inclusionProof(tree, m);
      assert.deepEqual(path.map(toHex), vectors.paths[`${m},${n}`], `path ${m},${n}`);
      assert.equal(await verifyInclusion(tree[m]!, m, n, path, root), true, `verify ${m},${n}`);
    }
    for (let m = 1; m < n; m++) {
      const proof = await consistencyProof(tree, m);
      assert.deepEqual(proof.map(toHex), vectors.cons[`${m},${n}`], `consistency ${m},${n}`);
      const oldRoot = fromHex(vectors.roots[m - 1]!);
      assert.equal(await verifyConsistency(m, n, oldRoot, root, proof), true, `c ${m},${n}`);
    }
  }
});

test('proofs fail on any tampering', async () => {
  const leaves = await Promise.all(
    Array.from({ length: 13 }, (_, i) => hashLeaf(Uint8Array.of(i))),
  );
  const root = await merkleRoot(leaves);
  const path = await inclusionProof(leaves, 5);
  assert.equal(await verifyInclusion(leaves[5]!, 5, 13, path, root), true);
  assert.equal(await verifyInclusion(leaves[6]!, 5, 13, path, root), false, 'other leaf');
  assert.equal(await verifyInclusion(leaves[5]!, 6, 13, path, root), false, 'other index');
  // The size is bound to the root by the signed checkpoint; a size with another path shape fails.
  assert.equal(await verifyInclusion(leaves[5]!, 5, 6, path, root), false, 'other size');
  const bent = path.map((p, i) => (i === 1 ? leaves[0]! : p));
  assert.equal(await verifyInclusion(leaves[5]!, 5, 13, bent, root), false, 'bent path');
  // Consistency: a rewritten old leaf, or a shrunk log, never verifies as an extension.
  const oldRoot = await merkleRoot(leaves.slice(0, 7));
  const proof = await consistencyProof(leaves, 7);
  assert.equal(await verifyConsistency(7, 13, oldRoot, root, proof), true);
  const rewritten = [...leaves];
  rewritten[2] = await hashLeaf(Uint8Array.of(99));
  const rewrittenRoot = await merkleRoot(rewritten);
  assert.equal(await verifyConsistency(7, 13, oldRoot, rewrittenRoot, proof), false);
  assert.equal(await verifyConsistency(13, 7, root, oldRoot, proof), false, 'shrink');
  assert.equal(await verifyConsistency(7, 13, oldRoot, root, []), false, 'empty proof');
});

test('the agent leaf is salted, length-prefixed and day-granular', async () => {
  const salt = new Uint8Array(32).fill(7);
  const a = await agentLeafHash('agent-1', salt, '2026-09-28');
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, await agentLeafHash('agent-1', new Uint8Array(32).fill(8), '2026-09-28'));
  assert.notDeepEqual(a, await agentLeafHash('agent-1', salt, '2026-09-29'));
  assert.notDeepEqual(a, await agentLeafHash('agent-2', salt, '2026-09-28'));
  await assert.rejects(agentLeafHash('a', new Uint8Array(16), '2026-09-28'), /32 bytes/);
  await assert.rejects(agentLeafHash('a', salt, '2026-09-28T10:00'), /YYYY-MM-DD/);
});

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  return { privateKey, jwk };
}

const subcounts = { in_person_accounts: 2, in_ai_workspaces: 1, unclaimed: 1, revoked: 0 };
async function chain(roots: { size: number; root: Uint8Array; consistency: Uint8Array[] }[]) {
  const out: Checkpoint[] = [];
  for (const [i, r] of roots.entries()) {
    const body: CheckpointBody = {
      v: 1,
      date: `2026-10-0${i + 1}`,
      tree_size: r.size,
      withdrawn: 0,
      root: toHex(r.root),
      prev_hash: out.at(-1)?.hash ?? null,
      subcounts: { ...subcounts, unclaimed: r.size - 3 },
    };
    out.push({
      ...body,
      hash: await checkpointHash(body),
      signature: null,
      consistency: r.consistency.map(toHex),
    });
  }
  return out;
}

test('the checkpoint chain: any rewrite, shrink or broken link shows', async () => {
  const leaves = await Promise.all(Array.from({ length: 9 }, (_, i) => hashLeaf(Uint8Array.of(i))));
  const cps = await chain([
    { size: 4, root: await merkleRoot(leaves.slice(0, 4)), consistency: [] },
    {
      size: 6,
      root: await merkleRoot(leaves.slice(0, 6)),
      consistency: await consistencyProof(leaves.slice(0, 6), 4),
    },
    { size: 9, root: await merkleRoot(leaves), consistency: await consistencyProof(leaves, 6) },
  ]);
  assert.deepEqual(await verifyChain(cps), []);
  // A changed count without a new hash.
  const edited = cps.map((cp, i) => (i === 1 ? { ...cp, tree_size: 7 } : cp));
  assert.ok((await verifyChain(edited)).some((p) => p.problem.includes('hash')));
  // History rewritten consistently (new hashes) still breaks the link to the next day.
  const body = { ...cps[1]!, root: toHex(await merkleRoot(leaves.slice(1, 7))) };
  const { hash: _h, signature: _s, consistency: _c, ...rest } = body;
  const rewritten = [cps[0]!, { ...body, hash: await checkpointHash(rest) }, cps[2]!];
  const problems = await verifyChain(rewritten);
  assert.ok(problems.some((p) => p.problem.includes('previous checkpoint')));
  assert.ok(problems.some((p) => p.problem.includes('append-only')));
  // Sub-counts must add up to the counted total.
  const bad = { ...cps[0]!, subcounts: { ...subcounts, unclaimed: 9 } };
  const { hash: _x, signature: _y, consistency: _z, ...b } = bad;
  assert.ok(
    (await verifyChain([{ ...bad, hash: await checkpointHash(b) }])).some((p) =>
      p.problem.includes('sub-counts'),
    ),
  );
});

test('checkpoint signatures are domain-separated from Agent Card JWS (amendment a)', async () => {
  const { privateKey, jwk } = keyPair();
  const hash = 'a'.repeat(64);
  const input = checkpointSigningInput(hash);
  assert.equal(new TextDecoder().decode(input), `${CHECKPOINT_SIGNING_CONTEXT}\n${hash}`);
  const sig = sign(null, input, privateKey).toString('base64url');
  assert.equal(await verifyCheckpointSignature(hash, sig, jwk), true);
  assert.equal(await verifyCheckpointSignature('b'.repeat(64), sig, jwk), false);
  // A JWS signing input is base64url "header.payload": it can never contain ':' or '\n', so no
  // Agent Card signature covers a checkpoint's bytes and vice versa.
  const jwsInput = `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(hash).toString('base64url')}`;
  assert.doesNotMatch(jwsInput, /[:\n]/);
  const cardSig = sign(null, Buffer.from(jwsInput), privateKey).toString('base64url');
  assert.equal(await verifyCheckpointSignature(hash, cardSig, jwk), false);
  // A signature over the bare hash (no context) is refused too.
  const bare = sign(null, Buffer.from(hash), privateKey).toString('base64url');
  assert.equal(await verifyCheckpointSignature(hash, bare, jwk), false);
  assert.throws(() => checkpointSigningInput('xyz'), /Invalid/);
});

test('an owner proof verifies against its checkpoint, and nothing else', async () => {
  const salt = new Uint8Array(32).fill(3);
  const others = await Promise.all(Array.from({ length: 6 }, (_, i) => hashLeaf(Uint8Array.of(i))));
  const mine = await agentLeafHash('agent-9', salt, '2026-09-28');
  const leaves = [...others.slice(0, 4), mine, ...others.slice(4)];
  const root = toHex(await merkleRoot(leaves));
  const proof = {
    idx: 4,
    salt: toHex(salt),
    created_day: '2026-09-28',
    checkpoint_date: '2026-10-01',
    tree_size: leaves.length,
    audit_path: (await inclusionProof(leaves, 4)).map(toHex),
  };
  const cp = { date: '2026-10-01', tree_size: leaves.length, root };
  assert.deepEqual(await verifyAgentProof('agent-9', proof, cp), { ok: true });
  assert.equal((await verifyAgentProof('agent-8', proof, cp)).ok, false);
  assert.equal(
    (await verifyAgentProof('agent-9', { ...proof, created_day: '2026-09-27' }, cp)).ok,
    false,
  );
  assert.equal((await verifyAgentProof('agent-9', proof, { ...cp, date: '2026-10-02' })).ok, false);
});

test('paths from cached tree levels equal the RFC 6962 paths for every size up to 70', async () => {
  const leaves = await Promise.all(
    Array.from({ length: 70 }, (_, i) => hashLeaf(Uint8Array.of(i))),
  );
  for (let n = 1; n <= 70; n++) {
    const tree = leaves.slice(0, n);
    const levels = await treeLevels(tree);
    assert.equal(toHex(levels.at(-1)![0]!), toHex(await merkleRoot(tree)), `root ${n}`);
    for (let m = 0; m < n; m++)
      assert.deepEqual(
        inclusionProofFromLevels(levels, m).map(toHex),
        (await inclusionProof(tree, m)).map(toHex),
        `path ${m},${n}`,
      );
  }
  assert.throws(() => inclusionProofFromLevels([[leaves[0]!]], 1), /out of range/);
});
