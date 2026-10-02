import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { createApp } from '../server/app.js';
import type { ProviderPostRequest } from '../server/responder/providers.js';
import { WAKE_DRAIN_PATH, cronAuthorized, registerWakeCron } from '../server/wake/cron.js';
import { createOutbox, type Claimed } from '../server/wake/webhooks.js';

/**
 * The scheduled wake outbox drain (Vercel Cron). On serverless nothing runs between
 * requests, so a retry that the after-commit drain could not wait for must be picked up by the
 * cron route. The route fails closed: 404 without the exact CRON_SECRET bearer.
 */
const SECRET = 'a-sufficiently-long-cron-secret';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const FAKE_ANTHROPIC = 'sk-ant-api03-test-anthropic-placeholder-0000';

test('vercel.json schedules the wake drain every minute', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    crons?: { path: string; schedule: string }[];
  };
  assert.deepEqual(
    config.crons?.find((item) => item.path === WAKE_DRAIN_PATH),
    { path: WAKE_DRAIN_PATH, schedule: '* * * * *' },
  );
});

test('the cron route fails closed and drains only with the exact bearer secret', async (t) => {
  let drains = 0;
  const wake = {
    drainNow: async () => {
      drains++;
      return { webhooks: 2, responder: 1 };
    },
  };
  const app = Fastify();
  registerWakeCron(app, { wake, cronSecret: SECRET });
  const unset = Fastify();
  registerWakeCron(unset, { wake, cronSecret: undefined });
  const short = Fastify();
  registerWakeCron(short, { wake, cronSecret: 'too-short' });
  t.after(() => Promise.all([app.close(), unset.close(), short.close()]));
  for (const authorization of [
    undefined,
    '',
    SECRET,
    'Bearer wrong',
    `Bearer ${SECRET}x`,
    `Bearer ${SECRET.slice(0, -1)}T`,
    `Basic ${SECRET}`,
  ]) {
    const res = await app.inject({
      url: WAKE_DRAIN_PATH,
      headers: authorization === undefined ? {} : { authorization },
    });
    assert.equal(res.statusCode, 404, String(authorization));
  }
  // No configured secret (or a weak one): never open, whatever is sent.
  for (const server of [unset, short])
    for (const authorization of ['Bearer ', 'Bearer undefined', 'Bearer too-short'])
      assert.equal(
        (await server.inject({ url: WAKE_DRAIN_PATH, headers: { authorization } })).statusCode,
        404,
      );
  assert.equal(drains, 0);
  const ok = await app.inject({
    url: WAKE_DRAIN_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { webhooks: 2, responder: 1 });
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.equal(drains, 1);
  assert.equal(cronAuthorized(`Bearer ${SECRET}`, SECRET), true);
  assert.equal(cronAuthorized(undefined, undefined), false);
});

test('a provider retry the after-commit drain cannot wait for is delivered by the cron drain', async (t) => {
  // The app reads CRON_SECRET when it registers the route.
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = SECRET;
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const requests: ProviderPostRequest[] = [];
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    responder: {
      enabled: true,
      env: { CITY_RESPONDER_KEK: randomBytes(32).toString('base64') },
      transport: async () => ({ status: 200 }),
      postTransport: async (request) => {
        requests.push(request);
        // The provider asks for a minute: longer than the inline drain's 20 s budget.
        if (requests.length === 1) return { status: 429, retryAfterMs: 60_000, json: {} };
        return {
          status: 200,
          retryAfterMs: null,
          json: {
            content: [{ type: 'text', text: 'Answered on retry.' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 5 },
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
      payload: JSON.stringify({ name, password: `Synthetic cron password ${name}` }),
    });
    return `cc_session=${res.cookies.find((item) => item.name === 'cc_session')!.value}`;
  };
  const agent = async (cookie: string, name: string) =>
    (
      await call(cookie, 'POST', '/api/agents', { name, capability: 'research', mode: 'hosted' })
    ).json().agent.id as string;
  const host = await account('Cron host');
  const hostAgent = await agent(host, 'Cron desk');
  const created = await call(host, 'POST', '/api/rooms', {
    agent_id: hostAgent,
    name: 'Cron room',
    idempotency_key: randomUUID(),
  });
  const room = created.json().room as { id: string; slug: string };
  const token = (created.json().link.link as string).split('#')[1];
  const owner = await account('Cron owner');
  const member = await agent(owner, 'Hazel');
  assert.equal(
    (
      await call(owner, 'POST', `/api/rooms/${room.slug}/join`, {
        token,
        agent_id: member,
        idempotency_key: randomUUID(),
      })
    ).statusCode,
    200,
  );
  await call(owner, 'POST', `/api/agents/${member}/responder/key`, {
    provider: 'anthropic',
    key: FAKE_ANTHROPIC,
  });
  const on = await call(owner, 'PUT', `/api/agents/${member}/responder`, { enabled: true });
  assert.equal(on.statusCode, 200, on.body);
  assert.equal(on.json().replies_available, true);
  const replies = async () =>
    (
      (await call(host, 'GET', `/api/rooms/${room.id}/messages?since=0`)).json().messages as Array<{
        text: string;
        auto_reply: unknown;
      }>
    ).filter((message) => message.auto_reply !== null);

  const said = await call(host, 'POST', `/api/rooms/${room.slug}/messages`, {
    text: 'Hello @hazel',
    idempotency_key: randomUUID(),
  });
  assert.equal(said.statusCode, 201, said.body);
  // The after-commit drain calls the provider once (429) and leaves the retry behind.
  for (let index = 0; index < 100 && requests.length < 1; index++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(requests.length, 1);
  assert.equal((await replies()).length, 0);

  // Past the backoff, with no other traffic: the cron route is the only trigger.
  // (The minute passes: both queue rows become due now, on the real clock the drain uses.)
  await app.city.db.query(
    "UPDATE responder_replies SET next_attempt_at=$1 WHERE status='pending'",
    [Date.now() - 1],
  );
  await app.city.db.query("UPDATE wake_outbox SET next_attempt_at=$1 WHERE kind='responder'", [
    Date.now() - 1,
  ]);
  const wrong = await app.inject({ url: WAKE_DRAIN_PATH, headers: { authorization: 'Bearer x' } });
  assert.equal(wrong.statusCode, 404);
  assert.equal(requests.length, 1, 'a refused cron call drains nothing');
  const cron = await app.inject({
    url: WAKE_DRAIN_PATH,
    headers: { authorization: `Bearer ${SECRET}` },
  });
  assert.equal(cron.statusCode, 200, cron.body);
  assert.deepEqual(Object.keys(cron.json()).sort(), ['responder', 'webhooks']);
  assert.ok(cron.json().responder >= 1, cron.body);
  // The cron call waited for the drain: the reply is in the room when it returns.
  assert.equal(requests.length, 2);
  const posted = await replies();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]!.text, 'Answered on retry.');
});

/** Due wake-up rows of one kind, straight in the tables (as tests/responder-outbox.test.ts). */
async function queue(
  t: { after: (fn: () => Promise<unknown>) => void },
  kind: 'https' | 'responder',
  rows: number,
) {
  const app = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => app.close());
  const db = app.city.db;
  const operator = randomUUID();
  await db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES($1,'Drain owner',$2,'x','y')",
    [operator, `drain-${operator}`],
  );
  for (let index = 0; index < rows; index++) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO wake_webhooks(id,agent_id,owner_id,url,events,salt,created_at,created_by,kind)
       VALUES($1,$2,$3,$4,ARRAY['mention'],'s',1,'test',$5)`,
      [id, randomUUID(), operator, kind === 'https' ? 'https://example.com/hook' : null, kind],
    );
    await db.query(
      `INSERT INTO wake_outbox(webhook_id,agent_id,kinds,event,pending,version,attempts,first_at,next_attempt_at,kind)
       SELECT id,agent_id,ARRAY['mention'],'{}'::jsonb,1,1,0,1,1,kind FROM wake_webhooks WHERE id=$1`,
      [id],
    );
  }
  return db;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a drain of more than 20 slow rows stops starting passes at its deadline', async (t) => {
  const db = await queue(t, 'https', 45);
  let delivered = 0;
  const outbox = createOutbox({
    db,
    clock: Date.now,
    keys: [],
    minPassMs: 200,
    transport: async () => {
      await sleep(300);
      delivered++;
      return { status: 200 };
    },
  });
  const started = Date.now();
  const handled = await outbox.drain(700);
  const elapsed = Date.now() - started;
  // Passes of 20 rows at 300 ms each: two fit, the third would start with < 200 ms left.
  assert.ok(elapsed < 700 + 300 + 400, `returned in ${elapsed} ms`);
  assert.ok(handled >= 20 && handled < 45, `handled ${handled}`);
  assert.equal(delivered, handled);
  const left = await db.query('SELECT 1 FROM wake_outbox');
  assert.equal(left.rows.length, 45 - handled, 'the rest stays queued for the next drain');
});

test('joining a running drain waits at most its own budget and never restarts it', async (t) => {
  const db = await queue(t, 'https', 45);
  const outbox = createOutbox({
    db,
    clock: Date.now,
    keys: [],
    minPassMs: 200,
    transport: async () => {
      await sleep(300);
      return { status: 200 };
    },
  });
  const started = Date.now();
  const first = outbox.drain(700);
  await sleep(50);
  const joined = Date.now();
  await outbox.drain(100);
  assert.ok(Date.now() - joined < 100 + 250, `joined wait ${Date.now() - joined} ms`);
  await first;
  // The short join did not extend the running drain past its own deadline.
  assert.ok(Date.now() - started < 700 + 300 + 400, `drain took ${Date.now() - started} ms`);
});

test('a handler (responder) pass gets the absolute deadline and none starts late', async (t) => {
  const db = await queue(t, 'responder', 12);
  const calls: Array<{ at: number; deadline: number }> = [];
  const outbox = createOutbox({
    db,
    clock: Date.now,
    keys: [],
    transport: async () => ({ status: 200 }),
    kind: 'responder',
    claimLimit: 5,
    minPassMs: 250,
    handler: async (_row: Claimed, deadline: number) => {
      calls.push({ at: Date.now(), deadline });
      await sleep(200);
      return { outcome: 'done' };
    },
  });
  const started = Date.now();
  await outbox.drain(600);
  assert.ok(calls.length >= 5 && calls.length < 12, `calls ${calls.length}`);
  for (const call of calls) {
    assert.ok(call.deadline <= started + 600 + 5, 'the deadline is absolute, never restarted');
    assert.ok(call.deadline - call.at >= 250 - 5, 'a pass starts only while minPassMs is left');
  }
});

test('the cron also runs the Elric drain under the same deadline; its failure never breaks the wake drain', async (t) => {
  const budgets: number[] = [];
  const lines: string[] = [];
  const wake = { drainNow: async () => ({ webhooks: 0, responder: 0 }) };
  const ok = Fastify();
  registerWakeCron(ok, {
    wake,
    cronSecret: SECRET,
    budgetMs: 12_000,
    drainElric: async (budget) => {
      budgets.push(budget);
      return 2;
    },
    log: (line) => lines.push(line),
  });
  const failing = Fastify();
  registerWakeCron(failing, {
    wake,
    cronSecret: SECRET,
    drainElric: async () => {
      throw new Error('elric down');
    },
    log: (line) => lines.push(line),
  });
  t.after(() => Promise.all([ok.close(), failing.close()]));
  const headers = { authorization: `Bearer ${SECRET}` };
  const first = await ok.inject({ url: WAKE_DRAIN_PATH, headers });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.json(), { webhooks: 0, responder: 0 }, 'the response shape is unchanged');
  assert.deepEqual(budgets, [12_000]);
  const second = await failing.inject({ url: WAKE_DRAIN_PATH, headers });
  assert.equal(second.statusCode, 200);
  assert.deepEqual(lines, [
    'elric.cron_drain handled=2 error=false',
    'elric.cron_drain handled=0 error=true',
  ]);
});
