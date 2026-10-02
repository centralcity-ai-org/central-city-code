import test from 'node:test';
import assert from 'node:assert/strict';
import { recordTurn, turnResult, type TurnView } from '../server/elric/turns.js';
import { ELRIC_OUTCOMES } from '../server/elric/schema.js';
import { elricFixture } from './elric-fixture.js';

/**
 * The owner's Elric activity (docs/ELRIC.md "Owner console"): GET /api/elric/turns with the
 * result filter, the room name while the owner can still see the room, the room link of a posted
 * reply, and no message content. Owner session only.
 */

const CONTENT_KEYS = ['text', 'content', 'parts', 'prompt', 'message', 'messages', 'reply', 'body'];

function assertNoContent(value: unknown, secrets: string[]) {
  const json = JSON.stringify(value);
  for (const secret of secrets) assert.ok(!json.includes(secret), `content leaked: ${secret}`);
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node && typeof node === 'object')
      for (const [key, child] of Object.entries(node)) {
        assert.ok(!CONTENT_KEYS.includes(key), `content field: ${key}`);
        walk(child);
      }
  };
  walk(value);
}

test('a real mock run: posted and refused turns, room name and link, no content', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Activity room');
  const guest = await f.account('Activity guest');
  const guestPerson = await f.joinPerson(guest, s.room, 'Gil');
  f.small.push({ text: 'Synthetic reply text 7731.' });
  await f.say(s.owner, s.room, '@Elric what is the plan? secret-question-5521', s.person);
  await f.say(guest, s.room, '@Elric guest asks secret-guest-9902', guestPerson);
  await f.elric.drain();

  const res = await f.call(s.owner.cookie, 'GET', '/api/elric/turns');
  assert.equal(res.statusCode, 200, res.body);
  const turns = res.json().turns as TurnView[];
  assert.equal(turns.length, 2);
  // A refused mention is logged when it is posted; the answered one when the run finishes.
  const posted = turns.find((turn) => turn.result === 'posted');
  const refused = turns.find((turn) => turn.result === 'refused');
  assert.ok(posted && refused, res.body);
  assert.equal(posted!.result, 'posted');
  assert.equal(posted!.reason_code, 'ok');
  assert.deepEqual(posted!.room, { id: s.room.id, name: 'Activity room' });
  assert.equal(posted!.link, `/rooms/${s.room.id}`);
  assert.ok(posted!.posted_seq! > posted!.source_seq);
  assert.equal(posted!.tier, 1);
  assert.equal(posted!.model, 'elric-1.0', 'the public model, never the real one');
  assert.ok(posted!.cost_units >= 0 && posted!.input_tokens > 0);
  assert.equal(refused!.result, 'refused');
  assert.equal(refused!.reason_code, 'not_owner');
  assert.equal(refused!.link, null, 'nothing was posted');
  assert.deepEqual(refused!.room, { id: s.room.id, name: 'Activity room' });
  assertNoContent(res.json(), [
    'secret-question-5521',
    'secret-guest-9902',
    'Synthetic reply text 7731',
  ]);

  // The current day's allowance per type, from the status route.
  const status = await f.call(s.owner.cookie, 'GET', '/api/elric');
  assert.equal(status.statusCode, 200, status.body);
  const usage = status.json().usage as {
    used: Record<string, number>;
    allowance: Record<string, number>;
  };
  assert.deepEqual(usage.allowance, { short: 20, summary: 4, tool: 5 });
  assert.equal(usage.used.short, 1);
});

test('filters: result and room; the room name disappears once the owner can no longer see it', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Kept room');
  const other = await f.room(s.host, s.hostAgent, 'Room without the owner');
  const owner = s.owner.operatorId;
  const base = {
    ownerId: owner,
    agentId: s.elricId,
    invokerMemberId: s.person,
    invokerKind: 'owner' as const,
  };
  const at = f.now();
  await recordTurn(f.db, { ...base, roomId: s.room.id, sourceSeq: 1, outcome: 'limit' }, at + 1);
  await recordTurn(f.db, { ...base, roomId: s.room.id, sourceSeq: 2, outcome: 'error' }, at + 2);
  await recordTurn(
    f.db,
    { ...base, roomId: s.room.id, sourceSeq: 3, outcome: 'cancelled', reason: 'paused' },
    at + 3,
  );
  await recordTurn(
    f.db,
    { ...base, roomId: other.id, sourceSeq: 4, outcome: 'ok', postedSeq: 5 },
    at + 4,
  );

  const list = async (query: string) => {
    const res = await f.call(s.owner.cookie, 'GET', `/api/elric/turns${query}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().turns as TurnView[];
  };
  assert.deepEqual(
    (await list('?result=limit')).map((turn) => turn.source_seq),
    [1],
  );
  assert.deepEqual(
    (await list('?result=cancelled')).map((turn) => [turn.source_seq, turn.reason_code]),
    [[3, 'paused']],
  );
  assert.deepEqual(
    (await list(`?room_id=${s.room.id}`)).map((turn) => turn.source_seq),
    [3, 2, 1],
  );
  // A room the owner has no membership in: no name, no link (only the stored id).
  const [foreign] = await list('?result=posted');
  assert.equal(foreign!.source_seq, 4);
  assert.equal(foreign!.room, null);
  assert.equal(foreign!.room_id, null, 'not even the id of a room the owner cannot see');
  assert.equal(foreign!.link, null);
  assert.ok(!JSON.stringify(await list('')).includes('Room without the owner'));
  // The host deletes the kept room: its turns stay listed, without the name.
  const deleted = await f.call(s.host.cookie, 'DELETE', `/api/rooms/${s.room.id}`, {
    confirm_name: 'Kept room',
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const after = await list(`?room_id=${s.room.id}`);
  assert.equal(after.length, 3);
  assert.ok(
    after.every((turn) => turn.room === null && turn.room_id === null && turn.link === null),
  );
  // An unknown filter value is a 400, not a silent full list.
  const bad = await f.call(s.owner.cookie, 'GET', '/api/elric/turns?result=everything');
  assert.equal(bad.statusCode, 400);
});

test('every outcome maps to exactly one result, and the SQL filter agrees', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Mapping room');
  let seq = 0;
  for (const outcome of ELRIC_OUTCOMES)
    for (const postedSeq of outcome === 'ok' || outcome === 'step_limit' ? [null, 99] : [null])
      await recordTurn(
        f.db,
        {
          ownerId: s.owner.operatorId,
          agentId: s.elricId,
          roomId: s.room.id,
          invokerMemberId: s.person,
          invokerKind: 'owner',
          sourceSeq: ++seq,
          outcome,
          postedSeq,
        },
        f.now() + seq,
      );
  const all = (await f.call(s.owner.cookie, 'GET', '/api/elric/turns?limit=100')).json()
    .turns as TurnView[];
  assert.equal(all.length, seq);
  for (const turn of all) assert.equal(turn.result, turnResult(turn.outcome, turn.posted_seq));
  let total = 0;
  for (const result of ['posted', 'refused', 'limit', 'cancelled', 'error']) {
    const page = (
      await f.call(s.owner.cookie, 'GET', `/api/elric/turns?limit=100&result=${result}`)
    ).json().turns as TurnView[];
    assert.ok(
      page.every((turn) => turn.result === result),
      result,
    );
    total += page.length;
  }
  assert.equal(total, seq, 'the five filters partition the log');
});

test('pagination with a filter: newest first, every turn once', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Paged room');
  for (let i = 1; i <= 7; i++)
    await recordTurn(
      f.db,
      {
        ownerId: s.owner.operatorId,
        agentId: s.elricId,
        roomId: s.room.id,
        invokerMemberId: s.person,
        invokerKind: 'owner',
        sourceSeq: i,
        outcome: i % 2 ? 'refused_access' : 'limit',
      },
      f.now() + i,
    );
  const seen: number[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const query = `?limit=2&result=refused${cursor ? `&cursor=${cursor}` : ''}`;
    const page = (await f.call(s.owner.cookie, 'GET', `/api/elric/turns${query}`)).json() as {
      turns: TurnView[];
      next_cursor: string | null;
    };
    seen.push(...page.turns.map((turn) => turn.source_seq));
    cursor = page.next_cursor;
    pages++;
  } while (cursor);
  assert.deepEqual(seen, [7, 5, 3, 1]);
  assert.equal(pages, 2);
  // A cursor the route did not hand out is a 400, never a silent restart at page 1.
  for (const bad of ['nonsense', Buffer.from('12:x:y').toString('base64url'), '%%%']) {
    const res = await f.call(s.owner.cookie, 'GET', `/api/elric/turns?cursor=${bad}`);
    assert.equal(res.statusCode, 400, bad);
    assert.equal(res.json().code, 'invalid_cursor', res.body);
  }
});

test('owner session only: other owners see nothing, and tokens never reach the turns', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Private room');
  await f.say(s.owner, s.room, '@Elric who is here', s.person);
  await f.elric.drain();
  const mine = (await f.call(s.owner.cookie, 'GET', '/api/elric/turns')).json();
  assert.equal(mine.turns.length, 1);

  // Another verified owner with their own Elric, even naming the room: nothing.
  const other = await f.account('Other activity owner');
  await f.verify(other);
  await f.addElric(other);
  for (const query of ['', `?room_id=${s.room.id}`, '?result=posted'])
    assert.deepEqual(
      (await f.call(other.cookie, 'GET', `/api/elric/turns${query}`)).json(),
      { turns: [], next_cursor: null },
      query,
    );
  // A member of the same room (the host) sees nothing of the owner's Elric either.
  assert.deepEqual((await f.call(s.host.cookie, 'GET', '/api/elric/turns')).json(), {
    turns: [],
    next_cursor: null,
  });

  // No session, an assistant grant and an agent credential: refused, no data.
  const granted = await f.call(s.owner.cookie, 'POST', '/api/assistant-access', {
    label: 'Synthetic reader',
    scopes: ['workspace:read', 'agents:control'],
    expiresInDays: 1,
  });
  assert.equal(granted.statusCode, 201, granted.body);
  const external = await f.call(s.owner.cookie, 'POST', '/api/agents', {
    name: 'External reader',
    capability: 'research',
    mode: 'external',
  });
  assert.equal(external.statusCode, 201, external.body);
  for (const authorization of [
    undefined,
    `Bearer ${granted.json().token as string}`,
    `Bearer ${external.json().token as string}`,
  ]) {
    for (const url of ['/api/elric/turns', '/api/elric']) {
      const res = await f.app.inject({
        method: 'GET',
        url,
        headers: { 'x-city-request': '1', ...(authorization ? { authorization } : {}) },
      });
      assert.equal(res.statusCode, 401, `${url} ${authorization?.slice(0, 12)}`);
      assert.ok(!res.body.includes(s.room.id));
    }
    const pause = await f.app.inject({
      method: 'POST',
      url: '/api/elric/revoke',
      headers: {
        'content-type': 'application/json',
        'x-city-request': '1',
        ...(authorization ? { authorization } : {}),
      },
      payload: '{}',
    });
    assert.equal(pause.statusCode, 401);
  }
});

test('console controls: pause, resume and revoke are reflected in the status', async (t) => {
  const f = await elricFixture(t);
  const s = await f.scene('Control room');
  const status = async () => (await f.call(s.owner.cookie, 'GET', '/api/elric')).json().status;
  assert.equal(await status(), 'active');
  assert.equal((await f.call(s.owner.cookie, 'POST', '/api/elric/pause', {})).statusCode, 200);
  assert.equal(await status(), 'paused');
  assert.equal((await f.call(s.owner.cookie, 'POST', '/api/elric/resume', {})).statusCode, 200);
  assert.equal(await status(), 'active');
  assert.equal((await f.call(s.owner.cookie, 'POST', '/api/elric/revoke', {})).statusCode, 200);
  const after = (await f.call(s.owner.cookie, 'GET', '/api/elric')).json();
  assert.equal(after.agent_id, null, 'a revoked Elric is no longer the current one');
  // Another owner cannot control it.
  const other = await f.account('Other controller');
  assert.equal((await f.call(other.cookie, 'POST', '/api/elric/pause', {})).statusCode, 404);
});
