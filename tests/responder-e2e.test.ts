import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { ProviderPostRequest } from '../server/responder/providers.js';

/**
 * Hosted responder end to end through the app: a room mention wakes the responder drain (wake outbox kind
 * 'responder'), the reply is posted into the room as the member with the server-stamped label,
 * members and the room show the responder, the host switch stops it, and auto-replies never
 * trigger each other. Fake provider; placeholder keys only.
 */
type App = Awaited<ReturnType<typeof createApp>>;
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const FAKE_ANTHROPIC = 'sk-ant-api03-test-anthropic-placeholder-0000';

async function setup(t: { after: (fn: () => Promise<unknown>) => void }) {
  const requests: ProviderPostRequest[] = [];
  const app: App = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    responder: {
      enabled: true,
      env: { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async () => ({ status: 200 }),
      postTransport: async (request) => {
        requests.push(request);
        const mentioned = /@([a-z-]+)/.exec(JSON.parse(request.body).messages?.[0]?.content ?? '');
        return {
          status: 200,
          retryAfterMs: null,
          json: {
            content: [
              { type: 'text', text: `Auto answer${mentioned ? ` to @${mentioned[1]}` : ''}.` },
            ],
            stop_reason: 'end_turn',
            usage: { input_tokens: 500, output_tokens: 20 },
          },
        };
      },
    },
  });
  t.after(() => app.close());
  const call = (cookie: string, method: string, url: string, body?: unknown) =>
    app.inject({
      method: method as 'GET',
      url,
      headers: { ...jsonHeaders, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const account = async (name: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      headers: jsonHeaders,
      payload: JSON.stringify({ name, password: `Synthetic e2e password ${name}` }),
    });
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const agent = async (cookie: string, name: string) =>
    (
      await call(cookie, 'POST', '/api/agents', { name, capability: 'research', mode: 'hosted' })
    ).json().agent.id as string;
  const host = await account('E2E host');
  const hostAgent = await agent(host, 'Host desk');
  const created = await call(host, 'POST', '/api/rooms', {
    agent_id: hostAgent,
    name: 'E2E room',
    idempotency_key: randomUUID(),
  });
  const room = created.json().room as { id: string; slug: string };
  const token = (created.json().link.link as string).split('#')[1];
  const responder = async (ownerName: string, agentName: string) => {
    const cookie = await account(ownerName);
    const id = await agent(cookie, agentName);
    const joined = await call(cookie, 'POST', `/api/rooms/${room.slug}/join`, {
      token,
      agent_id: id,
      idempotency_key: randomUUID(),
    });
    assert.equal(joined.statusCode, 200, joined.body);
    await call(cookie, 'POST', `/api/agents/${id}/responder/key`, {
      provider: 'anthropic',
      key: FAKE_ANTHROPIC,
    });
    const on = await call(cookie, 'PUT', `/api/agents/${id}/responder`, { enabled: true });
    assert.equal(on.statusCode, 200, on.body);
    return { cookie, id };
  };
  const read = async () =>
    (await call(host, 'GET', `/api/rooms/${room.id}/messages?since=0`)).json().messages as Array<{
      seq: number;
      sender: string;
      text: string;
      auto_reply: { provider: string; model: string } | null;
    }>;
  const until = async (check: () => Promise<boolean>) => {
    for (let index = 0; index < 100; index++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('timed out');
  };
  const say = (text: string) =>
    call(host, 'POST', `/api/rooms/${room.slug}/messages`, { text, idempotency_key: randomUUID() });
  return { app, call, host, room, account, responder, read, until, say, requests };
}

test('a mention is answered in the room as the member, labelled, and shown to members', async (t) => {
  const s = await setup(t);
  const hazel = await s.responder('E2E owner', 'Hazel');
  const roomView = (await s.call(s.host, 'GET', '/api/rooms'))
    .json()
    .rooms.find((item: { id: string }) => item.id === s.room.id);
  assert.equal(roomView.responders_allowed, true);
  assert.deepEqual(
    roomView.auto_responders.map((item: { name: string; provider: string }) => [
      item.name,
      item.provider,
    ]),
    [['Hazel', 'anthropic']],
  );
  const members = (await s.call(s.host, 'GET', `/api/rooms/${s.room.id}/members`)).json().members;
  const member = members.find((item: { id: string }) => item.id === hazel.id);
  assert.deepEqual(member.auto_reply, { provider: 'anthropic' });
  await s.say('Hello @hazel, can you help?');
  await s.until(async () => (await s.read()).some((message) => message.auto_reply !== null));
  const messages = await s.read();
  const reply = messages.find((message) => message.auto_reply !== null)!;
  assert.equal(reply.sender, 'Hazel');
  assert.deepEqual(reply.auto_reply, { provider: 'anthropic', model: 'claude-sonnet-5' });
  assert.equal(s.requests.length, 1);
  // A forged auto_reply in the post body is refused by the strict input.
  const forged = await s.call(s.host, 'POST', `/api/rooms/${s.room.slug}/messages`, {
    text: 'hi',
    idempotency_key: randomUUID(),
    auto_reply: { provider: 'anthropic', model: 'x' },
  });
  assert.equal(forged.statusCode, 400);
});

test('two responders never answer each other; the host switch stops them', async (t) => {
  const s = await setup(t);
  await s.responder('Owner A', 'Alpha');
  await s.responder('Owner B', 'Bravo');
  // Each auto-answer mentions the other responder; auto-replies wake nobody.
  await s.say('@alpha and @bravo, please both answer');
  await s.until(async () => (await s.read()).filter((m) => m.auto_reply).length === 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await s.read()).filter((m) => m.auto_reply).length, 2, 'no reply to a reply');
  assert.equal(s.requests.length, 2);
  // The host disallows responders: no more wake-ups, and members no longer show auto_reply.
  const off = await s.call(s.host, 'POST', `/api/rooms/${s.room.slug}/settings`, {
    responders_allowed: false,
  });
  assert.equal(off.statusCode, 200, off.body);
  assert.equal(off.json().room.responders_allowed, false);
  assert.deepEqual(off.json().room.auto_responders, []);
  await s.say('@alpha are you still there?');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(s.requests.length, 2, 'no provider call when the host disallows responders');
  const members = (await s.call(s.host, 'GET', `/api/rooms/${s.room.id}/members`)).json().members;
  assert.ok(members.every((item: { auto_reply: unknown }) => item.auto_reply === null));
});

test('people in rooms (#131): never a responder target, never woken; a person can ask an AI', async (t) => {
  const s = await setup(t);
  const hazel = await s.responder('E2E owner', 'Hazel');
  const link = await s.call(s.host, 'POST', '/api/links', { target: 'room', room_id: s.room.id });
  assert.equal(link.statusCode, 201, link.body);
  const pat = await s.account('E2E person');
  const joined = await s.call(pat, 'POST', '/api/rooms/join', {
    link: link.json().url,
    name: 'Pat',
    idempotency_key: randomUUID(),
  });
  assert.equal(joined.statusCode, 200, joined.body);
  const members = (await s.call(s.host, 'GET', `/api/rooms/${s.room.id}/members`)).json()
    .members as Array<{ id: string; kind: string; auto_reply: unknown }>;
  const person = members.find((item) => item.kind === 'person')!;
  assert.equal(person.auto_reply, null);
  const roomView = (await s.call(s.host, 'GET', '/api/rooms'))
    .json()
    .rooms.find((item: { id: string }) => item.id === s.room.id);
  assert.deepEqual(
    roomView.auto_responders.map((item: { agent_id: string }) => item.agent_id),
    [hazel.id],
  );
  // Mentioning the person records a mention for their own read, but no wake_outbox row.
  assert.equal((await s.say('Welcome @pat')).statusCode, 201);
  const outbox = await s.app.city.db.query('SELECT 1 FROM wake_outbox WHERE agent_id=$1', [
    person.id,
  ]);
  assert.equal(outbox.rows.length, 0, 'a person mention never enqueues a wake-up');
  // A person may @mention an AI with a responder: one reply, as the AI, labelled.
  const asked = await s.call(pat, 'POST', `/api/rooms/${s.room.id}/messages`, {
    text: 'Hi @hazel, a question from a person',
    idempotency_key: randomUUID(),
  });
  assert.equal(asked.statusCode, 201, asked.body);
  assert.equal(asked.json().message.sender_kind, 'person');
  await s.until(async () => (await s.read()).some((message) => message.auto_reply !== null));
  const reply = (await s.read()).find((message) => message.auto_reply !== null)!;
  assert.equal(reply.sender, 'Hazel');
  assert.equal(s.requests.length, 1);
});
