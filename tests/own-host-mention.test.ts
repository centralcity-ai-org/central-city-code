import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import { findMentions } from '../server/wake/mentions.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-own-host-mention-test-root-secret';

/**
 * "@<your own host>" is not a mention: when the owner of the room's host agent writes its name
 * (as a person, or as another of their agents), no mention is recorded, so nothing is woken and
 * no auto-reply runs. Anyone else mentions that host normally. Synthetic data only.
 */
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: 'https://centralcity.ai',
};
let address = 60;

async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: 'https://centralcity.ai',
      allowedOrigins: ['https://centralcity.ai'],
    },
    startWorkers: false,
  });
  t.after(() => app.close());
  const post = (url: string, body: unknown, extra = {}, remoteAddress = '203.0.113.12') =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const account = async (name: string, agentName: string) => {
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic own host mention password' },
      {},
      `203.0.113.${address++}`,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: agentName, capability: 'research', mode: 'hosted' },
      { cookie },
    );
    assert.equal(agent.statusCode, 201, agent.body);
    return { cookie, agentId: agent.json().agent.id as string };
  };
  const host = await account('Tea host', 'Alex');
  const created = await post(
    '/api/rooms',
    { name: 'Tea room', agent_id: host.agentId, idempotency_key: randomUUID() },
    { cookie: host.cookie },
  );
  assert.equal(created.statusCode, 201, created.body);
  const roomId = created.json().room.id as string;
  const link = await post('/api/links', { target: 'room', room_id: roomId }, host);
  assert.equal(link.statusCode, 201, link.body);
  const code = link.json().code as string;
  const joinAsPerson = async (cookie: string, name: string) => {
    const joined = await post(
      '/api/rooms/join',
      { idempotency_key: randomUUID(), code, name },
      { cookie },
    );
    assert.equal(joined.statusCode, 200, joined.body);
  };
  /** The caller's own person member in the room (its post id when it has several members). */
  const personOf = async (cookie: string) => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/rooms/${roomId}/members`,
      headers: { ...headers, cookie },
    });
    return (res.json().members as Array<{ id: string; own: boolean; kind?: string }>).find(
      (m) => m.own && m.kind === 'person',
    )!.id;
  };
  const say = async (cookie: string, text: string, agentId?: string) => {
    const posted = await post(
      `/api/rooms/${roomId}/messages`,
      { text, idempotency_key: randomUUID(), ...(agentId ? { agent_id: agentId } : {}) },
      { cookie },
    );
    assert.equal(posted.statusCode, 201, posted.body);
    return posted.json().message.seq as number;
  };
  const mentionedAt = async (seq: number) =>
    (
      await app.city.db.query<{ agent_id: string }>(
        'SELECT agent_id FROM mentions WHERE room_id=$1 AND source_seq=$2 ORDER BY agent_id',
        [roomId, seq],
      )
    ).rows.map((row) => row.agent_id);
  return { app, host, roomId, account, joinAsPerson, personOf, say, mentionedAt };
}

test('findMentions: excluded ids still resolve their names but are never mentioned', () => {
  const pool = [
    { id: 'a', name: 'Alex' },
    { id: 'b', name: 'Alex Two' },
    { id: 'c', name: 'Bea' },
  ];
  const found = findMentions('hi @Alex Two and @Alex and @Bea', pool, { exclude: ['a', 'b'] });
  assert.deepEqual(found.ids, ['c']);
  // A single id still works as before.
  assert.deepEqual(findMentions('@Bea @Alex', pool, { exclude: 'c' }).ids, ['a']);
});

test("the host's owner writing @<their host> records no mention; another member's does", async (t) => {
  const f = await fixture(t);
  // The host's owner in the room as a person.
  await f.joinAsPerson(f.host.cookie, 'Tea host');
  const me = await f.personOf(f.host.cookie);
  const own = await f.say(f.host.cookie, 'Note to self: @Alex please summarize', me);
  assert.deepEqual(await f.mentionedAt(own), [], 'own host: no mention, no wake-up');

  // Someone else mentions the same host normally.
  const ann = await f.account('Ann', 'Ann helper');
  await f.joinAsPerson(ann.cookie, 'Ann');
  const theirs = await f.say(ann.cookie, '@Alex can you summarize?');
  assert.deepEqual(await f.mentionedAt(theirs), [f.host.agentId]);

  // The host's owner still mentions everyone else (only their own host is skipped).
  const annId = await f.personOf(ann.cookie);
  const both = await f.say(f.host.cookie, 'Thanks @Ann, and @Alex too', me);
  assert.deepEqual(await f.mentionedAt(both), [annId]);
});
