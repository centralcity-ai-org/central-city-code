import test from 'node:test';
import assert from 'node:assert/strict';
import { elricFixture, permissiveLimiter } from './elric-fixture.js';

/**
 * 1,000 guest mentions of someone else's Elric: 0 room posts by Elric, 0 notices posted, 0
 * adapter calls, 0 spend; one sender-only notice; one audit row each.
 */
test('1000 guest mentions create 0 room posts and 0 adapter calls', async (t) => {
  const f = await elricFixture(t, { rateLimiter: permissiveLimiter });
  const s = await f.scene();
  const guest = await f.account('Guest flood');
  const guestPerson = await f.joinPerson(guest, s.room, 'Flood');
  const before = (await f.messages(s.room.id)).length;
  let notices = 0;
  for (let i = 0; i < 1_000; i++) {
    const posted = await f.say(guest, s.room, `@Elric do something ${i}`, guestPerson);
    if (posted.elric_notice) notices++;
  }
  await f.elric.drain();
  assert.equal(f.adapterCalls(), 0);
  assert.equal(notices, 1);
  const rows = await f.messages(s.room.id);
  assert.equal(rows.length - before, 1_000, 'only the guest’s own posts');
  assert.ok(rows.every((row) => row.sender_agent_id !== s.elricId));
  assert.equal((await f.invocations(s.elricId)).length, 0);
  assert.equal(await f.usage(s.owner.operatorId), undefined);
  assert.equal(await f.globalUsage(), undefined);
  const outcomes = await f.db.query<{ outcome: string; n: string }>(
    'SELECT outcome, count(*) AS n FROM elric_turns WHERE owner_id=$1 GROUP BY outcome',
    [s.owner.operatorId],
  );
  assert.deepEqual(
    outcomes.rows.map((row) => [row.outcome, Number(row.n)]),
    [['refused_invoker', 1_000]],
  );
});
