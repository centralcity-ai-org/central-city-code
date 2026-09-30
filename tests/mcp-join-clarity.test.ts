import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ASSISTANT_SCOPES } from '../shared/assistant.js';
import { INVITE_INVALID_MESSAGE, insufficientScopeMessage } from '../server/remote-mcp/tools.js';
import { type App, fixture, fullFlow, mcpCall, rpcResult } from './oauth-helpers.js';

/**
 * Feedback from an external AI joining a room from an invite link over its existing OAuth
 * connection: (a) a bare "Insufficient scope" looked like a bad invite link, and (b) a post result
 * was not explicit enough to verify before telling the user it was sent. Synthetic data only.
 */
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const ROOM_SCOPES = 'workspace:read agents:create rooms:join';
let addressCounter = 1;

/** An AI-owned workspace co-owned by a person, with a key holding every scope. */
async function keyOwner(app: App, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name, idempotency_key: randomUUID() }),
    remoteAddress: `198.51.${addressCounter++}.40`,
  });
  assert.equal(res.statusCode, 201, res.body);
  const id = res.json().workspace_id as string;
  const person = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({
      name: `Clarity co-owner ${addressCounter}`,
      password: 'Synthetic co-owner password',
    }),
    remoteAddress: `198.51.${addressCounter++}.41`,
  });
  assert.equal(person.statusCode, 201, person.body);
  const cookie = `cc_session=${person.cookies.find((item) => item.name === 'cc_session')!.value}`;
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...jsonHeaders, cookie },
    payload: JSON.stringify({ claim_token: res.json().claim_token }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const minted = await app.inject({
    method: 'POST',
    url: '/api/workspace-keys',
    headers: { ...jsonHeaders, cookie, 'x-city-workspace': id },
    payload: JSON.stringify({ label: 'clarity', scopes: [...ASSISTANT_SCOPES] }),
  });
  assert.equal(minted.statusCode, 201, minted.body);
  return minted.json().workspace_key as string;
}

async function tool(app: App, credential: string, name: string, args: unknown = {}) {
  const res = await mcpCall(app, credential, 'tools/call', { name, arguments: args });
  return { res, rpc: res.statusCode === 200 ? rpcResult(res.body) : undefined };
}
async function ok(app: App, credential: string, name: string, args: unknown = {}) {
  const { res, rpc } = await tool(app, credential, name, args);
  assert.equal(res.statusCode, 200, res.body);
  assert.notEqual(rpc!.result?.isError, true, res.body);
  return rpc!.result.structuredContent as Record<string, any>;
}
const texts = (result: { content: Array<{ type: string; text: string }> }) =>
  result.content.filter((item) => item.type === 'text').map((item) => item.text);
const errorOf = (result: { content: Array<{ text: string }> }) =>
  JSON.parse(result.content[0]!.text).error as Record<string, unknown>;

/** A host (workspace key) with a room, and a member (workspace key) already in it. */
async function scene(app: App) {
  const host = await keyOwner(app, 'Clarity host');
  const member = await keyOwner(app, 'Clarity member');
  const hostAgent = (
    await ok(app, host, 'city_create_agent', {
      name: 'Clarity host desk',
      description: 'Synthetic',
      capability: 'research',
      mode: 'external',
      idempotencyKey: randomUUID(),
    })
  ).agent.id as string;
  const created = await ok(app, host, 'city_create_room', {
    agent_id: hostAgent,
    name: 'Clarity desk',
    idempotency_key: randomUUID(),
  });
  const joined = await ok(app, member, 'city_join_room', {
    link: created.link.link,
    create: { name: 'Clarity joiner' },
    idempotency_key: randomUUID(),
  });
  return { host, member, roomId: created.room.id as string, link: created.link.link as string };
}

test('a grant without rooms:join gets an explicit step-up that is not about the invite', async (t) => {
  const { app } = await fixture(t);
  const { link } = await scene(app);
  const flow = await fullFlow(app, { scope: ROOM_SCOPES, scopes: ['agents:create'] });
  assert.equal(flow.tokens.scope, 'workspace:read agents:create');
  const { res } = await tool(app, flow.tokens.access_token, 'city_join_room', {
    link,
    create: { name: 'Blocked joiner' },
    idempotency_key: randomUUID(),
  });
  // The standards-compliant step-up is unchanged: 403 + WWW-Authenticate insufficient_scope with
  // every scope the tool needs.
  assert.equal(res.statusCode, 403, res.body);
  const challenge = String(res.headers['www-authenticate']);
  assert.match(challenge, /^Bearer error="insufficient_scope"/);
  assert.match(challenge, /scope="workspace:read rooms:join"/);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource/,
  );
  // The readable part names the missing scope, says the link is fine and gives both fixes.
  const expected =
    'This Central City connection does not include rooms:join. This is not a problem with your invite link. Reconnect Central City (disconnect it and connect again), sign in, and on the approval page keep Join rooms (rooms:join) ticked, then start a new chat, or use the no-account endpoint http://localhost/mcp/open and call city_join_invite with the link.';
  assert.ok(challenge.includes(`error_description="${expected}"`), challenge);
  assert.deepEqual(res.json(), { error: 'insufficient_scope', error_description: expected });
});

test('other missing scopes get the general explanation; workspace keys get a key fix', async (t) => {
  const { app } = await fixture(t);
  const flow = await fullFlow(app, { scopes: [] });
  const { res } = await tool(app, flow.tokens.access_token, 'city_create_agent', {
    name: 'Blocked',
    capability: 'extract',
    mode: 'hosted',
    idempotencyKey: randomUUID(),
  });
  assert.equal(res.statusCode, 403, res.body);
  assert.match(String(res.headers['www-authenticate']), /error="insufficient_scope"/);
  assert.equal(
    res.json().error_description,
    'This Central City connection does not include agents:create. Reconnect Central City (disconnect it and connect again), sign in, and on the approval page keep Create agent records (agents:create) ticked, then start a new chat.',
  );

  const host = await keyOwner(app, 'Key host');
  const narrow = await ok(app, host, 'city_create_workspace_key', {
    label: 'Host only',
    scopes: ['workspace:read', 'rooms:host'],
  });
  const keyed = await tool(app, narrow.workspace_key, 'city_join_room', {
    link: 'https://example.invalid/j/unused',
    agent_id: randomUUID(),
    idempotency_key: randomUUID(),
  });
  assert.equal(keyed.res.statusCode, 403, keyed.res.body);
  assert.match(String(keyed.res.headers['www-authenticate']), /scope="workspace:read rooms:join"/);
  const description = keyed.res.json().error_description as string;
  assert.match(description, /^This workspace key does not include rooms:join\./);
  assert.match(description, /not a problem with your invite link/);
  assert.match(description, /\/mcp\/open/);
});

test('room tools that take no link get a missing rooms:join explanation without the link sentence', async (t) => {
  // The room task tools are listed only with CITY_ROOM_TASKS=1.
  const saved = process.env.CITY_ROOM_TASKS;
  process.env.CITY_ROOM_TASKS = '1';
  t.after(() => {
    if (saved === undefined) delete process.env.CITY_ROOM_TASKS;
    else process.env.CITY_ROOM_TASKS = saved;
  });
  const { app } = await fixture(t);
  const flow = await fullFlow(app, { scope: ROOM_SCOPES, scopes: ['agents:create'] });
  const expected =
    'This Central City connection does not include rooms:join. Reconnect Central City (disconnect it and connect again), sign in, and on the approval page keep Join rooms (rooms:join) ticked, then start a new chat.';
  const roomId = randomUUID();
  for (const [name, args] of [
    ['city_room_read', { room_id: roomId }],
    ['city_room_members', { room_id: roomId }],
    ['city_room_task_list', { room_id: roomId }],
  ] as const) {
    const { res } = await tool(app, flow.tokens.access_token, name, args);
    assert.equal(res.statusCode, 403, `${name}: ${res.body}`);
    const challenge = String(res.headers['www-authenticate']);
    assert.match(challenge, /^Bearer error="insufficient_scope"/, name);
    assert.ok(challenge.includes(`error_description="${expected}"`), `${name}: ${challenge}`);
    assert.deepEqual(
      res.json(),
      { error: 'insufficient_scope', error_description: expected },
      name,
    );
  }

  // Workspace keys: the key fix, and still no invite-link sentence or no-account detour.
  const host = await keyOwner(app, 'Key reader');
  const narrow = await ok(app, host, 'city_create_workspace_key', {
    label: 'Host only',
    scopes: ['workspace:read', 'rooms:host'],
  });
  const keyed = await tool(app, narrow.workspace_key, 'city_room_read', { room_id: roomId });
  assert.equal(keyed.res.statusCode, 403, keyed.res.body);
  assert.equal(
    keyed.res.json().error_description,
    'This workspace key does not include rooms:join. Use a workspace key that includes Join rooms (rooms:join) (a co-owner can mint one).',
  );
});

test('insufficientScopeMessage keeps the invite-link sentence for city_join_room only', () => {
  const join = insufficientScopeMessage(
    ['rooms:join'],
    { origin: 'https://example.test' },
    'city_join_room',
  );
  assert.match(join, /This is not a problem with your invite link\./);
  assert.match(join, /https:\/\/example\.test\/mcp\/open and call city_join_invite/);
  for (const name of ['city_room_read', 'city_room_post', 'city_room_task_claim', undefined]) {
    const text = insufficientScopeMessage(['rooms:join'], { origin: 'https://example.test' }, name);
    assert.doesNotMatch(text, /invite link|mcp\/open|city_join_invite/, String(name));
    assert.match(text, /^This Central City connection does not include rooms:join\. /);
  }
});

test('a missing call-specific scope is a structured insufficient_scope error, checked before the link', async (t) => {
  const { app } = await fixture(t);
  const { link, roomId } = await scene(app);
  const members = async () =>
    Number(
      (
        await app.city.db.query<{ n: string | number }>(
          'SELECT count(*) AS n FROM room_members WHERE room_id=$1',
          [roomId],
        )
      ).rows[0]!.n,
    );
  const before = await members();
  // rooms:join passes the step-up; joining as a new agent also needs agents:create.
  const flow = await fullFlow(app, { scope: ROOM_SCOPES, scopes: ['rooms:join'] });
  const { res, rpc } = await tool(app, flow.tokens.access_token, 'city_join_room', {
    link,
    create: { name: 'Needs agents:create' },
    idempotency_key: randomUUID(),
  });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(rpc!.result.isError, true);
  assert.deepEqual(errorOf(rpc!.result), {
    code: 'insufficient_scope',
    kind: 'forbidden',
    message:
      'This Central City connection does not include agents:create. Reconnect Central City (disconnect it and connect again), sign in, and on the approval page keep Create agent records (agents:create) ticked, then start a new chat.',
    retryable: false,
    required_scope: 'agents:create',
  });
  // A wrong link is refused identically: the scope is checked before the link is looked up, so
  // the answer says nothing about whether a link is valid.
  for (const other of [`${link.slice(0, -4)}AAAA`, 'https://example.invalid/j/unused']) {
    const refused = await tool(app, flow.tokens.access_token, 'city_join_room', {
      link: other,
      create: { name: 'Needs agents:create' },
      idempotency_key: randomUUID(),
    });
    assert.equal(refused.res.statusCode, 200, refused.res.body);
    assert.deepEqual(refused.rpc!.result, rpc!.result);
  }
  assert.equal(await members(), before, 'nobody joined');
});

test('unusable invites stay one uniform invite_invalid that clearly blames the link', async (t) => {
  const { app } = await fixture(t);
  const { member, link } = await scene(app);
  const bodies = new Set<string>();
  for (const bad of [
    `${link.slice(0, -4)}AAAA`,
    'http://localhost/r/no-such-room#AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ]) {
    const { rpc } = await tool(app, member, 'city_join_room', {
      link: bad,
      agent_id: randomUUID(),
      idempotency_key: randomUUID(),
    });
    assert.equal(rpc!.result.isError, true);
    const error = errorOf(rpc!.result);
    assert.equal(error.code, 'invite_invalid');
    assert.equal(error.message, INVITE_INVALID_MESSAGE);
    assert.match(String(error.message), /invalid, expired, used up or revoked: ask the host/);
    bodies.add(JSON.stringify(rpc!.result));
  }
  assert.equal(bodies.size, 1, 'identical answers');
});

test('city_room_post confirms explicitly; failures are real tool errors', async (t) => {
  const { app } = await fixture(t);
  const { host, member, roomId } = await scene(app);
  const listed = rpcResult((await mcpCall(app, member, 'tools/list')).body).result.tools as Array<{
    name: string;
    description: string;
  }>;
  for (const name of ['city_room_post', 'city_join_room'])
    assert.match(
      listed.find((item) => item.name === name)!.description,
      /Only tell the user a message was sent after (this tool|city_room_post) returns its seq\./,
    );

  const args = { room_id: roomId, text: 'Clarity hello', idempotency_key: randomUUID() };
  const { rpc } = await tool(app, member, 'city_room_post', args);
  const posted = rpc!.result;
  assert.notEqual(posted.isError, true);
  assert.equal(posted.structuredContent.posted, true);
  const seq = posted.structuredContent.message.seq as number;
  assert.ok(Number.isInteger(seq) && seq >= 1);
  // Backward compatible: the first text block is still the structured JSON.
  assert.deepEqual(JSON.parse(posted.content[0].text), posted.structuredContent);
  assert.ok(texts(posted).includes(`Posted in room ${roomId} as message #${seq}.`), posted.content);
  // The message really is there under that seq.
  const read = await ok(app, host, 'city_room_read', { room_id: roomId });
  assert.equal(read.messages.find((m: { seq: number }) => m.seq === seq).text, 'Clarity hello');

  // A retry with the same key says it was not posted twice.
  const again = (await tool(app, member, 'city_room_post', args)).rpc!.result;
  assert.equal(again.structuredContent.message.seq, seq);
  assert.equal(again.structuredContent.replayed, true);
  assert.match(texts(again)[1]!, new RegExp(`as message #${seq}\\. \\(Replay .*not posted twice`));

  // Invalid call (neither text nor parts): an error result, never success-shaped.
  const invalid = (
    await tool(app, member, 'city_room_post', { room_id: roomId, idempotency_key: randomUUID() })
  ).rpc!;
  assert.equal(invalid.result?.isError, true, JSON.stringify(invalid));
  assert.equal(invalid.result.structuredContent?.posted, undefined);
  assert.doesNotMatch(texts(invalid.result).join('\n'), /Posted in/);

  // Closed room: a real tool error with a clear message.
  await ok(app, host, 'city_room_close', { room_id: roomId });
  const closed = (
    await tool(app, member, 'city_room_post', {
      room_id: roomId,
      text: 'After close',
      idempotency_key: randomUUID(),
    })
  ).rpc!.result;
  assert.equal(closed.isError, true);
  assert.equal(closed.structuredContent, undefined);
  const error = errorOf(closed);
  assert.equal(error.retryable, false);
  assert.match(String(error.message), /closed/i);
  assert.match(texts(closed)[1]!, /^Not posted: .*closed.* Nothing was added to the room\.$/i);
  assert.doesNotMatch(texts(closed).join('\n'), /Posted in/);
});

test('a server failure while posting is "not confirmed", retryable, and never success-shaped', async (t) => {
  const { app } = await fixture(t);
  const { host, member, roomId } = await scene(app);
  // Synthetic fault: every insert into room_messages fails inside the post transaction.
  await app.city.db.query(`CREATE FUNCTION clarity_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$`);
  await app.city.db.query(
    'CREATE TRIGGER clarity_fail BEFORE INSERT ON room_messages FOR EACH ROW EXECUTE FUNCTION clarity_fail()',
  );
  const args = { room_id: roomId, text: 'Clarity maybe', idempotency_key: randomUUID() };
  const failed = (await tool(app, member, 'city_room_post', args)).rpc!.result;
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent, undefined);
  const error = errorOf(failed);
  assert.equal(error.code, 'internal_error');
  assert.equal(error.retryable, true);
  assert.doesNotMatch(JSON.stringify(failed), /synthetic storage failure/);
  assert.match(texts(failed)[1]!, /^Not confirmed: .*Retry with the same idempotency_key/);
  assert.doesNotMatch(texts(failed).join('\n'), /Posted in|Not posted/);

  // Once storage recovers, the retry with the same key posts exactly once and confirms.
  await app.city.db.query('DROP TRIGGER clarity_fail ON room_messages');
  const retried = await ok(app, member, 'city_room_post', args);
  assert.equal(retried.posted, true);
  assert.equal(retried.replayed, false);
  const read = await ok(app, host, 'city_room_read', { room_id: roomId });
  assert.equal(read.messages.filter((m: { text: string }) => m.text === args.text).length, 1);
});
