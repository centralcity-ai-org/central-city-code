import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { Agent } from '../shared/types.js';
import type { AgentMessage } from '../server/messaging/contract.js';
import { pairKey } from '../server/messaging/service.js';
import {
  legacyPairContextId,
  remediatePairContexts,
  SINCE,
} from '../scripts/remediate-pair-contexts.js';

/**
 * The one-off remediation of #61's derivable pair ids (scripts/remediate-pair-contexts.ts).
 * Rows under a derivable id are written through the normal API with an explicit context_id, which
 * gives exactly what #61 stored. Synthetic data only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  let now = SINCE + 60_000;
  const app = await createApp({ dataDir: ':memory:', startWorkers: false, now: () => now });
  t.after(() => app.close());
  const registered = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: 'Remediation owner', password: 'Synthetic remediation pw' }),
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
      description: 'Synthetic remediation agent',
      capability: 'research',
      mode: 'external',
    });
    assert.equal(res.statusCode, 201, res.body);
    return (res.json() as { agent: Agent }).agent;
  };
  const [a, b, c] = [await agent('Rem A'), await agent('Rem B'), await agent('Rem C')];
  for (const [from, to] of [
    [a, b],
    [b, a],
    [c, b],
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
  const db = app.city.db;
  const count = async (sql: string, params: unknown[]) =>
    Number((await db.query<{ n: number | string }>(sql, params)).rows[0]!.n);
  const inContext = (context: string) =>
    count('SELECT count(*) AS n FROM messages WHERE context_id=$1', [context]);
  const mentionsIn = (context: string) =>
    count('SELECT count(*) AS n FROM mentions WHERE context_id=$1', [context]);
  const stored = async (x: Agent, y: Agent) =>
    (
      await db.query<{ context_id: string }>(
        'SELECT context_id FROM pair_contexts WHERE low_id=$1 AND high_id=$2',
        pairKey(x.id, y.id),
      )
    ).rows[0]?.context_id;
  /** Rewrites a temporary thread to the derivable id, as #61 stored it (the API no longer does). */
  const asLegacy = async (temporary: string, legacy: string) => {
    await db.query('UPDATE mentions SET context_id=$2 WHERE context_id=$1', [temporary, legacy]);
    await db.query('UPDATE messages SET context_id=$2 WHERE context_id=$1', [temporary, legacy]);
  };
  return {
    app,
    db,
    a,
    b,
    c,
    send,
    inContext,
    mentionsIn,
    stored,
    asLegacy,
    setNow: (v: number) => (now = v),
  };
}

test('dry run reports counts only and changes nothing; --confirm moves the pair, idempotently', async (t) => {
  const { db, a, b, c, send, inContext, mentionsIn, stored, asLegacy } = await setup(t);
  const legacy = legacyPairContextId(a.id, b.id);
  // As #61 stored them: both directions of A–B under the derivable id, one with a mention.
  await send(a, { to_agent_id: b.id, text: 'Hello @Rem B', context_id: 'era:61' });
  await send(b, { to_agent_id: a.id, text: 'Hi', context_id: 'era:61' });
  await asLegacy('era:61', legacy);
  // Someone else's probe under the same id (possible before A and B talked) is theirs and stays.
  await send(c, { to_agent_id: b.id, text: 'Probe', context_id: 'probe:temporary' });
  await asLegacy('probe:temporary', legacy);
  assert.equal(await inContext(legacy), 3);
  assert.equal(await mentionsIn(legacy), 1);

  const dry = await remediatePairContexts(db);
  assert.deepEqual(dry, { mode: 'dry-run', scanned: 2, pairs: 1, messages: 2, mentions: 1 });
  assert.equal(await inContext(legacy), 3, 'a dry run changes nothing');
  assert.equal(await stored(a, b), undefined);
  // Counts only: nothing identifying in the output.
  for (const value of Object.values(dry))
    assert.ok(typeof value === 'number' || value === 'dry-run');

  const applied = await remediatePairContexts(db, { confirm: true });
  assert.deepEqual(applied, { mode: 'applied', scanned: 2, pairs: 1, messages: 2, mentions: 1 });
  const target = await stored(a, b);
  assert.ok(target && target !== legacy);
  assert.equal(await inContext(target), 2);
  assert.equal(await mentionsIn(target), 1);
  assert.equal(await inContext(legacy), 1, "only C's probe remains under the old id");

  const again = await remediatePairContexts(db, { confirm: true });
  assert.equal(again.pairs, 0, 'idempotent');
  assert.equal(again.messages, 0);
});

test('a pair that already has a stored id is moved into it, and messages before SINCE are ignored', async (t) => {
  const { db, a, b, send, inContext, stored, asLegacy, setNow } = await setup(t);
  // The new code already gave A–B a stored id (e.g. after the lookback window moved on).
  await send(a, { to_agent_id: b.id, text: 'Stored first' });
  const existing = await stored(a, b);
  assert.ok(existing);
  const legacy = legacyPairContextId(a.id, b.id);
  await send(b, { to_agent_id: a.id, text: 'Under the old id', context_id: 'era:61' });
  await asLegacy('era:61', legacy);
  const moved = await remediatePairContexts(db, { confirm: true });
  assert.equal(moved.pairs, 1);
  assert.equal(await stored(a, b), existing, 'reuses the stored id');
  assert.equal(await inContext(existing!), 2);
  assert.equal(await inContext(legacy), 0);

  // Rows under that id from before #61 was deployed are not #61's doing and are left.
  setNow(SINCE - 3_600_000);
  await send(a, { to_agent_id: b.id, text: 'Before', context_id: 'era:before' });
  await asLegacy('era:before', legacy);
  const later = await remediatePairContexts(db, { confirm: true });
  assert.equal(later.pairs, 0);
  assert.equal(await inContext(legacy), 1);
});
