import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { elricFixture } from './elric-fixture.js';

/**
 * The host adds their own AI (here Elric) to a room they host without having joined it as a
 * person (bring-your-AI by room id, no invite). The host can never add someone else's agent, and
 * a non-member still cannot add an AI by room id.
 */
test("a host adds their own Elric by room id; never another owner's agent; a stranger cannot", async (t) => {
  const f = await elricFixture(t);
  const host = await f.account('Hosting owner');
  await f.verify(host);
  const desk = await f.agent(host, 'Owner desk');
  const room = await f.room(host, desk, 'Owner room');
  const elricId = await f.addElric(host);
  const join = (cookie: string, agentId: string) =>
    f.call(cookie, 'POST', `/api/rooms/${room.id}/join`, {
      agent_id: agentId,
      idempotency_key: randomUUID(),
    });

  const added = await join(host.cookie, elricId);
  assert.equal(added.statusCode, 200, added.body);
  const members = await f.db.query<{ agent_id: string }>(
    'SELECT agent_id FROM room_members WHERE room_id=$1 AND removed_at IS NULL',
    [room.id],
  );
  assert.ok(members.rows.some((row) => row.agent_id === elricId));

  // Someone else's agent: not in the host's workspace, so never added.
  const other = await f.account('Other owner');
  const theirs = await f.agent(other, 'Their bot');
  const foreign = await join(host.cookie, theirs);
  assert.ok(foreign.statusCode >= 400, foreign.body);
  assert.ok(
    !(
      await f.db.query('SELECT 1 FROM room_members WHERE room_id=$1 AND agent_id=$2', [
        room.id,
        theirs,
      ])
    ).rows.length,
  );
  // A stranger (not host, not a person member) cannot bring an AI by room id.
  const stranger = await join(other.cookie, theirs);
  assert.equal(stranger.statusCode, 404, stranger.body);
  // The host's own bring-AI works even when members may not bring their AI.
  const rule = await f.call(host.cookie, 'POST', `/api/rooms/${room.id}/people`, {
    members_may_bring_ai: false,
  });
  assert.ok(rule.statusCode < 300, rule.body);
  const another = await f.agent(host, 'Owner second desk');
  assert.equal((await join(host.cookie, another)).statusCode, 200);
});
