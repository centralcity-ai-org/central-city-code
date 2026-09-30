import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { listMigrations, runMigrations } from '../server/migrations.js';
import { registerMessagingMigration } from '../server/messaging/schema.js';
import { registerAiWorkspacesMigration } from '../server/workspaces/schema.js';
import { registerCrossConnectionsMigration } from '../server/connections/schema.js';
import { registerRoomsMigration } from '../server/rooms/schema.js';
import { registerJoinLinksMigration } from '../server/links/schema.js';
import { registerWakeMigration } from '../server/wake/schema.js';
import { registerResultsMigration } from '../server/results/schema.js';
import {
  LEGACY_PAIR_ID_FUNCTION,
  PAIR_REMEDIATION_SINCE,
  pairRemediationMigration,
  registerPairRemediationMigration,
} from '../server/messaging/remediation-schema.js';
import { pairKey } from '../server/messaging/service.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage } from '../server/messaging/contract.js';
import {
  legacyPairContextId,
  remediatePairContexts,
  SINCE,
} from '../scripts/remediate-pair-contexts.js';

/**
 * Migration 25 `pair_context_remediation` (server/messaging/remediation-schema.ts), the SQL form
 * of scripts/remediate-pair-contexts.ts. Synthetic, low-entropy fixture ids only.
 */
registerMessagingMigration();
registerAiWorkspacesMigration();
registerCrossConnectionsMigration();
registerRoomsMigration();
registerJoinLinksMigration();
registerWakeMigration();
registerResultsMigration();
registerPairRemediationMigration();

type Db = Parameters<typeof remediatePairContexts>[0];
const VERSION = pairRemediationMigration.version;

// Agents. Ids are ASCII, like real agent ids; "Agent-echo" sorts before "agent-delta" by code point.
const A = 'agent-alpha';
const B = 'agent-bravo';
const C = 'agent-charlie';
const D = 'agent-delta';
const E = 'Agent-echo';
const F = 'agent-foxtrot';
const G = 'agent-golf';
// Long ids push the hashed input past one 64-byte SHA-1 block.
const H = `agent-${'hotel'.repeat(12)}`;
const I = `agent-${'india'.repeat(12)}`;
const J = '00000000-0000-4000-8000-00000000000a';
const K = '00000000-0000-4000-8000-00000000000b';
const L = 'agent-lima';
const M = 'agent-mike';
const OWNER: Record<string, string> = {
  [A]: 'owner-1',
  [B]: 'owner-1',
  [C]: 'owner-2',
  [D]: 'owner-2',
  [E]: 'owner-3',
  [F]: 'owner-3',
  [G]: 'owner-3',
  [H]: 'owner-4',
  [I]: 'owner-5',
  [J]: 'owner-5',
  [K]: 'owner-6',
  [L]: 'owner-6',
  [M]: 'owner-6',
};
const STORED_DE = '00000000-0000-4000-8000-0000000000de';
const STORED_LM = '00000000-0000-4000-8000-00000000001a';
const AFTER = SINCE + 60_000;
const BEFORE = SINCE - 3_600_000;

/** Fixture writer for raw rows as #61 stored them (the API no longer writes derivable ids). */
function writer(db: PGlite) {
  const seqs = new Map<string, number>();
  let ids = 0;
  const next = (agent: string) => {
    const seq = (seqs.get(agent) ?? 0) + 1;
    seqs.set(agent, seq);
    return seq;
  };
  const message = async (
    from: string,
    to: string,
    context: string,
    createdAt: number,
    mentions: string[] = [],
  ) => {
    const id = `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;
    const seq = next(to);
    await db.query(
      `INSERT INTO messages(recipient_id,seq,id,sender_id,sender_owner_id,recipient_owner_id,context_id,parts,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'[{"type":"text","text":"fixture"}]',$8)`,
      [to, seq, id, from, OWNER[from], OWNER[to], context, createdAt],
    );
    for (const agent of mentions)
      await db.query(
        `INSERT INTO mentions(agent_id,seq,owner_id,source_kind,source_id,source_seq,context_id,from_agent_id,from_name,excerpt,created_at)
         VALUES($1,$2,$3,'message',$4,$5,$6,$7,'Fixture','fixture',$8)`,
        [agent, next(`mention:${agent}`), OWNER[agent], id, seq, context, from, createdAt],
      );
  };
  return { message };
}

const legacy = (x: string, y: string) => legacyPairContextId(x, y);

/** A database at migration 24 with #61-era rows; returns it and a copy for the TS script. */
async function fixture(t: { after: (fn: () => Promise<unknown>) => void }) {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await runMigrations(
    db,
    listMigrations().filter((migration) => migration.version < VERSION),
  );
  const { message } = writer(db);
  // A–B: #61-era pair, both directions, one with a mention, plus an older message under the same id.
  await message(A, B, legacy(A, B), BEFORE);
  await message(A, B, legacy(A, B), AFTER, [B]);
  await message(B, A, legacy(A, B), AFTER + 1000);
  // C probes A–B's derivable id (with a mention of B): C's rows are C's and stay.
  await message(C, B, legacy(A, B), AFTER + 2000, [B]);
  // D–E already has a stored id (the #75 guard); its #61 rows move into it.
  await db.query(
    'INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)',
    [...pairKey(D, E), STORED_DE, AFTER],
  );
  await message(D, E, STORED_DE, AFTER);
  await message(E, D, legacy(D, E), AFTER + 1000, [D]);
  // F–G: derivable id only before SINCE, not #61's doing: untouched.
  await message(F, G, legacy(F, G), BEFORE);
  // H–I: long ids (multi-block SHA-1).
  await message(H, I, legacy(H, I), AFTER);
  await message(I, H, legacy(H, I), AFTER + 1000, [H]);
  // J–K: an explicit thread and another pair's derivable id, since SINCE: untouched.
  await message(J, K, 'thread-jk', AFTER);
  await message(J, K, legacy(A, K), AFTER + 1000);
  // L–M: already remediated (rows under its stored id): untouched.
  await db.query(
    'INSERT INTO pair_contexts(low_id,high_id,context_id,created_at) VALUES($1,$2,$3,$4)',
    [...pairKey(L, M), STORED_LM, AFTER],
  );
  await message(L, M, STORED_LM, AFTER, [M]);
  return db;
}

async function copyOf(db: PGlite, t: { after: (fn: () => Promise<unknown>) => void }) {
  const copy = await PGlite.create({ loadDataDir: await db.dumpDataDir() });
  t.after(() => copy.close());
  return copy;
}

/** Full table state, ordered. */
async function state(db: PGlite) {
  const rows = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
  return {
    messages: await rows(
      'SELECT recipient_id,seq::int AS seq,id::text AS id,sender_id,context_id FROM messages ORDER BY recipient_id,seq',
    ),
    mentions: await rows(
      'SELECT agent_id,seq::int AS seq,source_id,context_id FROM mentions ORDER BY agent_id,seq',
    ),
    pairs: await rows(
      'SELECT low_id,high_id,context_id FROM pair_contexts ORDER BY low_id COLLATE "C",high_id COLLATE "C"',
    ),
  };
}

/** State with each newly stored random pair id replaced by its pair, so two runs compare. */
async function normalized(db: PGlite) {
  const s = await state(db);
  const fixed = new Set([STORED_DE, STORED_LM]);
  const names = new Map<string, string>();
  for (const row of s.pairs)
    if (!fixed.has(row.context_id as string))
      names.set(row.context_id as string, `new:${row.low_id as string}|${row.high_id as string}`);
  const name = (id: unknown) => names.get(id as string) ?? id;
  return {
    messages: s.messages.map((row) => ({ ...row, context_id: name(row.context_id) })),
    mentions: s.mentions.map((row) => ({ ...row, context_id: name(row.context_id) })),
    pairs: s.pairs.map((row) => ({ ...row, context_id: name(row.context_id) })),
  };
}

async function contextOf(db: PGlite, x: string, y: string) {
  return (
    await db.query<{ context_id: string }>(
      'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
      pairKey(x, y),
    )
  ).rows[0]?.context_id;
}

async function count(db: PGlite, sql: string, params: unknown[]) {
  return Number((await db.query<{ n: number | string }>(sql, params)).rows[0]!.n);
}

test('the SQL legacy id equals legacyPairContextId, byte for byte', async (t) => {
  const db = await PGlite.create('memory://');
  t.after(() => db.close());
  await db.exec(LEGACY_PAIR_ID_FUNCTION);
  assert.equal(PAIR_REMEDIATION_SINCE, SINCE);
  const inputs: [string, string][] = [
    [A, B],
    [D, E],
    [H, I],
    [J, K],
    ['', ''],
  ];
  // Every total input length around the 55/56/64-byte SHA-1 padding boundaries, and non-ASCII.
  for (let n = 0; n < 150; n++) inputs.push(['a'.repeat(n), `b${'é'.repeat(n % 5)}`]);
  for (const [x, y] of inputs) {
    const [low, high] = pairKey(x, y);
    const sql = (
      await db.query<{ id: string }>('SELECT pg_temp.city_legacy_pair_id($1,$2) AS id', [low, high])
    ).rows[0]!.id;
    assert.equal(sql, legacyPairContextId(x, y), `${low.length}+${high.length}`);
  }
});

test('migration 25 moves each #61-era pair into its stored id; probes and other rows stay', async (t) => {
  const db = await fixture(t);
  const before = await state(db);
  const notices: string[] = [];
  const result = await runMigrations(db, listMigrations());
  // Later migrations may also apply (e.g. 28); only 25 matters here, and nothing before it.
  assert.ok(result.applied.includes(VERSION), `migration ${VERSION} applied`);
  assert.ok(
    result.applied.every((version) => version >= VERSION),
    'nothing older reapplied',
  );

  const ab = await contextOf(db, A, B);
  const hi = await contextOf(db, H, I);
  assert.ok(ab && hi);
  for (const id of [ab, hi]) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab]/);
  assert.equal(await contextOf(db, D, E), STORED_DE, 'an existing pair_contexts id is reused');
  assert.equal(await contextOf(db, L, M), STORED_LM);
  assert.equal(await contextOf(db, F, G), undefined, 'no row for a pair that was not moved');
  assert.equal(await contextOf(db, J, K), undefined);
  // Stored in (low, high) code point order, as pair_contexts defines it.
  assert.deepEqual(
    (await state(db)).pairs.map((row) => [row.low_id, row.high_id]),
    [
      [E, D],
      [A, B],
      [H, I],
      [L, M],
    ].map(([x, y]) => pairKey(x!, y!)),
  );

  const inContext = (id: string) =>
    count(db, 'SELECT count(*) AS n FROM messages WHERE context_id=$1', [id]);
  const mentionsIn = (id: string) =>
    count(db, 'SELECT count(*) AS n FROM mentions WHERE context_id=$1', [id]);
  assert.equal(await inContext(ab), 3, "A–B's own messages, including the pre-SINCE one");
  assert.equal(await mentionsIn(ab), 1);
  assert.equal(await inContext(legacy(A, B)), 1, "only C's probe remains under the old id");
  assert.equal(await mentionsIn(legacy(A, B)), 1, "and the mention of C's probe");
  assert.equal(await inContext(STORED_DE), 2);
  assert.equal(await mentionsIn(STORED_DE), 1);
  assert.equal(await inContext(legacy(D, E)), 0);
  assert.equal(await inContext(hi), 2);
  assert.equal(await mentionsIn(hi), 1);
  assert.equal(await inContext(legacy(F, G)), 1, 'pre-SINCE rows are not #61-era');
  assert.equal(await inContext('thread-jk'), 1);
  assert.equal(await inContext(legacy(A, K)), 1);
  assert.equal(await inContext(STORED_LM), 1);

  // Only context ids changed, and only on the moved rows.
  const after = await state(db);
  const strip = (rows: Record<string, unknown>[]) =>
    rows.map((row) => ({ ...row, context_id: undefined }));
  assert.deepEqual(strip(after.messages), strip(before.messages));
  assert.deepEqual(strip(after.mentions), strip(before.mentions));
  const changed = after.messages.filter(
    (row, index) => row.context_id !== before.messages[index]!.context_id,
  ).length;
  assert.equal(changed, 3 + 1 + 2);

  // Running the SQL again is a no-op, and its NOTICE carries counts only.
  await db.exec(pairRemediationMigration.sql, {
    onNotice: (notice) => notices.push(notice.message ?? ''),
  });
  assert.deepEqual(await state(db), after);
  assert.deepEqual(notices, ['pair_context_remediation: 0 pairs, 0 messages, 0 mentions moved']);
});

test('the first run reports counts only', async (t) => {
  const db = await fixture(t);
  const notices: string[] = [];
  await db.exec(pairRemediationMigration.sql, {
    onNotice: (notice) => notices.push(notice.message ?? ''),
  });
  assert.deepEqual(notices, ['pair_context_remediation: 3 pairs, 6 messages, 3 mentions moved']);
});

test('the SQL migration leaves exactly the state the TS script leaves', async (t) => {
  const db = await fixture(t);
  const copy = await copyOf(db, t);
  await runMigrations(db, listMigrations());
  const counts = await remediatePairContexts(copy as unknown as Db, { confirm: true });
  assert.deepEqual(
    { pairs: counts.pairs, messages: counts.messages, mentions: counts.mentions },
    { pairs: 3, messages: 6, mentions: 3 },
  );
  assert.deepEqual(await normalized(db), await normalized(copy));
  // And the script finds nothing left to do after the migration.
  const again = await remediatePairContexts(db as unknown as Db, { confirm: true });
  assert.equal(again.pairs, 0);
  assert.equal(again.messages, 0);
});

test('nothing is written under a legacy id after the migration', async (t) => {
  let now = SINCE + 60_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Migration owner', password: 'Synthetic migration pw' }),
  });
  assert.equal(registered.statusCode, 201, registered.body);
  const cookie = `cc_session=${registered.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const call = (url: string, body: unknown) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...jsonHeaders, cookie },
      payload: JSON.stringify(body),
    });
  const agent = async (name: string) => {
    const res = await call('/api/agents', {
      name,
      description: 'Synthetic migration agent',
      capability: 'research',
      mode: 'external',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: Agent }).agent;
  };
  const [a, b] = [await agent('Mig A'), await agent('Mig B')];
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const)
    assert.equal(
      (await call('/api/connections', { fromAgentId: from.id, toAgentId: to.id })).statusCode,
      201,
    );
  const send = async (from: Agent, body: Record<string, unknown>) => {
    const res = await call(`/api/agents/${from.id}/messages`, {
      idempotency_key: randomUUID(),
      ...body,
    });
    assert.equal(res.statusCode, 201, res.body);
    now += 1000;
    return res.json().message as AgentMessage;
  };
  const db = app.city.db as unknown as PGlite;
  const old = legacyPairContextId(a.id, b.id);
  // As #61 stored them, written through the API under a temporary id and rewritten.
  const first = await send(a, { to_agent_id: b.id, text: 'Hello @Mig B', context_id: 'era:61' });
  await send(b, { to_agent_id: a.id, text: 'Hi', context_id: 'era:61' });
  await db.query("UPDATE mentions SET context_id=$1 WHERE context_id='era:61'", [old]);
  await db.query("UPDATE messages SET context_id=$1 WHERE context_id='era:61'", [old]);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM messages WHERE context_id=$1', [old]), 2);

  // The ledger already has 25 (it ran at startup on an empty database); run its SQL on the rows.
  await db.exec(pairRemediationMigration.sql);
  const stored = await contextOf(db, a.id, b.id);
  assert.ok(stored && stored !== old);

  // New sends: implicit, explicit old id, and a reply to a #61-era message.
  const sent = [
    await send(a, { to_agent_id: b.id, text: 'Implicit' }),
    await send(b, { to_agent_id: a.id, text: 'Explicit old id', context_id: old }),
    await send(b, { to_agent_id: a.id, text: 'Reply', reply_to: first.id }),
  ];
  for (const message of sent) assert.equal(message.context_id, stored);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM messages WHERE context_id=$1', [old]), 0);
  assert.equal(await count(db, 'SELECT count(*) AS n FROM mentions WHERE context_id=$1', [old]), 0);
  assert.equal(
    await count(db, 'SELECT count(*) AS n FROM pair_contexts WHERE context_id=$1', [old]),
    0,
  );
  assert.equal(
    await count(db, 'SELECT count(*) AS n FROM messages WHERE context_id=$1', [stored]),
    5,
  );
});
