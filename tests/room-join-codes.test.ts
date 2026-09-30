import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { callOpenTool, injectTransport, outcomeErrorCode } from '../scripts/smoke/ai-guest.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-join-codes-test-root-not-a-real-secret';

/**
 * A live test (2026-09-29): an AI host (no console) could not get a /j/ link or a short
 * code, and the no-account path refused the /r/ room link city_create_room returns. Now the room
 * service returns join_link and short_code (recomputed from the join-link row, refreshed every 24
 * hours) and every join path accepts the room link. Synthetic data only.
 */
const ORIGIN = 'https://centralcity.ai';
const HOUR = 3_600_000;
const JOIN = /^https:\/\/centralcity\.ai\/j\/[A-Za-z0-9_-]{43}$/;
const SHORT = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  limits: Partial<CityLimits> = {},
) {
  let time = Date.now();
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    now: () => time,
    limits,
  });
  t.after(() => app.close());
  let address = 10;
  const post = (url: string, body: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        host: 'centralcity.ai',
        origin: ORIGIN,
        ...extra,
      },
      payload: JSON.stringify(body),
      remoteAddress: `203.0.113.${address}`,
    });
  /** An AI-owned workspace whose co-owner minted a key with every scope (rooms:host included). */
  const owner = async (name: string) => {
    address++;
    const res = await post('/api/public/workspaces', { name, idempotency_key: randomUUID() });
    assert.equal(res.statusCode, 201, res.body);
    const person = await post('/api/auth/register', {
      name: `Co-owner ${address}`,
      password: 'Synthetic co-owner password',
    });
    assert.equal(person.statusCode, 201, person.body);
    const cookie = `cc_session=${person.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const claimed = await post(
      '/api/workspaces/claim',
      { claim_token: res.json().claim_token },
      { cookie },
    );
    assert.equal(claimed.statusCode, 200, claimed.body);
    const minted = await post(
      '/api/workspace-keys',
      { label: 'room host', scopes: [...ASSISTANT_SCOPES] },
      { cookie, 'x-city-workspace': res.json().workspace_id },
    );
    assert.equal(minted.statusCode, 201, minted.body);
    return minted.json().workspace_key as string;
  };
  const call = (key: string, name: string, args: unknown = {}) =>
    post(`/api/assistant/tools/${name}`, args, { authorization: `Bearer ${key}` });
  const ok = async (key: string, name: string, args: unknown = {}) => {
    const res = await call(key, name, args);
    assert.equal(res.statusCode, 200, `${name}: ${res.body}`);
    return res.json();
  };
  const agent = async (key: string, name: string) =>
    (
      await ok(key, 'city_create_agent', {
        name,
        description: 'Synthetic room member',
        capability: 'research',
        mode: 'external',
        idempotencyKey: randomUUID(),
      })
    ).agent.id as string;
  /** No-account admission over REST (bootstrap, then redeem with the same pasted text). */
  const guest = async (pasted: string, name = 'Guest AI', redeemWith = pasted) => {
    address++;
    const start = await post('/api/public/invites/bootstrap', { code: pasted });
    if (start.statusCode !== 200) return start;
    return post('/api/public/invites/redeem', {
      code: redeemWith,
      handle: start.json().handle,
      name,
    });
  };
  const transport = injectTransport(async (req) => {
    address++;
    const res = await app.inject({
      method: req.method,
      url: req.path,
      headers: {
        host: 'centralcity.ai',
        'x-forwarded-proto': 'https',
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...req.headers,
      },
      ...(req.body === undefined ? {} : { payload: JSON.stringify(req.body) }),
      remoteAddress: `203.0.113.${address}`,
    });
    return { statusCode: res.statusCode, body: res.body };
  }, ORIGIN);
  /** A person signed in to the console (cookie session). */
  const consoleUser = async (name: string) => {
    address++;
    const registered = await post('/api/auth/register', {
      name,
      password: 'Synthetic console password',
    });
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    return { post: (url: string, body: unknown) => post(url, body, { cookie }) };
  };
  return {
    db: app.city.db,
    console: consoleUser,
    owner,
    call,
    ok,
    agent,
    guest,
    transport,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

test('an AI host gets a /j/ link and a short code, stable until a fresh one is due', async (t) => {
  const f = await fixture(t);
  const host = await f.owner('Host workspace');
  const created = await f.ok(host, 'city_create_room', {
    agent_id: await f.agent(host, 'Host desk'),
    name: 'Join codes room',
    idempotency_key: randomUUID(),
  });
  const link = created.link;
  assert.match(link.join_link, JOIN);
  assert.match(link.short_code, SHORT);
  assert.match(link.link, /\/r\/join-codes-room-[0-9a-f]{8}#crr_/);
  const roomId = created.room.id as string;
  // Recomputed, not stored: the same link and code on every read while it has 12+ hours left.
  const again = await f.ok(host, 'city_room_link', { room_id: roomId });
  assert.equal(again.join_link, link.join_link);
  assert.equal(again.short_code, link.short_code);
  assert.equal(Date.parse(again.join_link_expires_at) - Date.parse(link.join_link_expires_at), 0);
  const stored = await f.ok(host, 'city_room_link', { room_id: roomId });
  assert.equal(stored.join_link, link.join_link);
  // After 13 hours a fresh one is returned; the earlier one keeps working until its 24 hours.
  f.advance(13 * HOUR);
  const fresh = await f.ok(host, 'city_room_link', { room_id: roomId });
  assert.notEqual(fresh.join_link, link.join_link);
  assert.notEqual(fresh.short_code, link.short_code);
  assert.equal(
    Date.parse(fresh.join_link_expires_at) - Date.parse(link.join_link_expires_at),
    13 * HOUR,
  );
  assert.equal((await f.guest(link.join_link, 'Early')).statusCode, 200);
  assert.equal((await f.guest(fresh.short_code, 'Short')).statusCode, 200);
  f.advance(12 * HOUR);
  const expired = await f.guest(link.join_link, 'Late');
  assert.equal(expired.statusCode, 404, expired.body);
  assert.equal(expired.json().code, 'invite_invalid');
  assert.equal((await f.guest(fresh.join_link, 'On time')).statusCode, 200);
});

test('every join path accepts the room link, the join link and the short code', async (t) => {
  const f = await fixture(t);
  const host = await f.owner('Host workspace');
  const member = await f.owner('Member workspace');
  const created = await f.ok(host, 'city_create_room', {
    agent_id: await f.agent(host, 'Host desk'),
    name: 'Paths room',
    idempotency_key: randomUUID(),
  });
  const { link, join_link: joinLink, short_code: short } = created.link;
  // No account, REST: the /r/ link (also pasted loosely), the /j/ link and the short code.
  for (const [pasted, redeemWith] of [
    [link, link],
    [` Join us: ${link.replace('https://', '')} `, link],
    [joinLink, joinLink],
    [short, short],
  ] as const) {
    const joined = await f.guest(pasted, 'Guest', redeemWith);
    assert.equal(joined.statusCode, 200, `${pasted}: ${joined.body}`);
    assert.equal(joined.json().room_id, created.room.id);
  }
  // No account, /mcp/open: the room link.
  const open = await callOpenTool(f.transport, 'city_join_invite', {
    invite_link: link,
    name: 'Open guest',
  });
  assert.equal(open.result?.isError, undefined, open.raw);
  assert.equal(open.result?.structuredContent?.['room_id'], created.room.id);
  // Signed in: the join link.
  const signedIn = await f.call(member, 'city_join_room', {
    link: joinLink,
    agent_id: await f.agent(member, 'Member AI'),
    idempotency_key: randomUUID(),
  });
  assert.equal(signedIn.statusCode, 200, signedIn.body);
  // A room link with a wrong slug or token is the uniform invite_invalid.
  const wrongSlug = await f.guest(link.replace(/\/r\/[a-z0-9-]+#/, '/r/other-room#'));
  assert.equal(wrongSlug.statusCode, 404, wrongSlug.body);
  const wrongToken = await f.guest(link.slice(0, -2) + (link.endsWith('AA') ? 'BB' : 'AA'));
  assert.equal(wrongToken.json().code, 'invite_invalid');
});

test('rotation revokes the join link, short code and room link together; closing says closed', async (t) => {
  const f = await fixture(t);
  const host = await f.owner('Host workspace');
  const created = await f.ok(host, 'city_create_room', {
    agent_id: await f.agent(host, 'Host desk'),
    name: 'Rotate room',
    idempotency_key: randomUUID(),
  });
  const roomId = created.room.id as string;
  const before = created.link;
  const rotated = await f.ok(host, 'city_room_link', {
    room_id: roomId,
    rotate: true,
    idempotency_key: randomUUID(),
  });
  assert.match(rotated.join_link, JOIN);
  assert.notEqual(rotated.join_link, before.join_link);
  for (const old of [before.link, before.join_link, before.short_code]) {
    const res = await f.guest(old);
    assert.equal(res.statusCode, 404, `${old}: ${res.body}`);
    assert.equal(res.json().code, 'invite_invalid');
  }
  assert.equal((await f.guest(rotated.join_link)).statusCode, 200);
  f.advance(60_000);
  await f.ok(host, 'city_room_close', { room_id: roomId });
  // Codes rotated away before the close stay the uniform invite_invalid.
  for (const old of [before.link, before.join_link]) {
    const res = await f.guest(old);
    assert.equal(res.statusCode, 404, `${old}: ${res.body}`);
    assert.equal(res.json().code, 'invite_invalid');
  }
  for (const closed of [rotated.link, rotated.join_link]) {
    const res = await f.guest(closed);
    assert.equal(res.statusCode, 409, `${closed}: ${res.body}`);
    assert.equal(res.json().code, 'room_closed');
  }
  const open = await callOpenTool(f.transport, 'city_join_invite', {
    invite_link: rotated.link,
    name: 'Too late',
  });
  assert.equal(outcomeErrorCode(open), 'room_closed');
  assert.equal((await f.call(host, 'city_room_link', { room_id: roomId })).statusCode, 409);
});

test('signed-in joins refuse links of other hosts and with user info; the console never mints', async (t) => {
  const f = await fixture(t);
  const host = await f.owner('Host workspace');
  const member = await f.owner('Member workspace');
  const created = await f.ok(host, 'city_create_room', {
    agent_id: await f.agent(host, 'Host desk'),
    name: 'Hosts room',
    idempotency_key: randomUUID(),
  });
  const memberAgent = await f.agent(member, 'Member AI');
  const { link, join_link: joinLink } = created.link;
  for (const foreign of [
    link.replace('https://centralcity.ai', 'https://evil.example'),
    joinLink.replace('https://centralcity.ai', 'https://centralcity.ai.evil.example'),
    link.replace('https://', 'https://someone@'),
  ]) {
    const res = await f.call(member, 'city_join_room', {
      link: foreign,
      agent_id: memberAgent,
      idempotency_key: randomUUID(),
    });
    assert.ok([400, 404].includes(res.statusCode), `${foreign}: ${res.body}`);
    assert.equal(res.json().code, 'invite_invalid', foreign);
  }
  const www = await f.call(member, 'city_join_room', {
    link: ` Join: ${joinLink.replace('https://', 'www.')}/ `,
    agent_id: memberAgent,
    idempotency_key: randomUUID(),
  });
  assert.equal(www.statusCode, 200, www.body);
  // A room created in the console gets no default join link (the console has POST /api/links).
  const person = await f.console('Console host');
  const hostAgent = await person.post('/api/agents', {
    name: 'Console desk',
    capability: 'research',
    mode: 'hosted',
  });
  assert.equal(hostAgent.statusCode, 201, hostAgent.body);
  const room = await person.post('/api/rooms', {
    name: 'Console room',
    agent_id: hostAgent.json().agent.id,
    idempotency_key: randomUUID(),
  });
  assert.equal(room.statusCode, 201, room.body);
  assert.equal(room.json().link.join_link, null);
  assert.equal(room.json().link.short_code, null);
});

test('redeem charges the address budget before a pasted room link can mint a join link', async (t) => {
  const f = await fixture(t, { unclaimedCreatesPerSourcePerHour: 1 });
  const person = await f.console('Console host');
  const desk = await person.post('/api/agents', {
    name: 'Console desk',
    capability: 'research',
    mode: 'hosted',
  });
  const room = (
    await person.post('/api/rooms', {
      name: 'Budget room',
      agent_id: desk.json().agent.id,
      idempotency_key: randomUUID(),
    })
  ).json();
  assert.equal(room.link.join_link, null, 'the console mints no default join link');
  const console = await person.post('/api/links', { target: 'room', room_id: room.room.id });
  assert.equal(console.statusCode, 201, console.body);
  const rows = async () =>
    Number(
      (
        await f.db.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM join_links WHERE room_id=$1',
          [room.room.id],
        )
      ).rows[0]!.n,
    );
  assert.equal(await rows(), 1);
  // The bootstrap (with the console's /j/ link) spends this address's whole budget; the redeem,
  // pasting the room link instead, is refused before the room link is resolved.
  const refused = await f.guest(console.json().url, 'Over budget', room.link.link);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(await rows(), 1, 'no default join link was minted for the refused redeem');
});
