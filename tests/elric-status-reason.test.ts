import test from 'node:test';
import assert from 'node:assert/strict';
import { elricFixture } from './elric-fixture.js';

/**
 * GET /api/elric tells the owner WHY they are not eligible yet (eligibility_reason), so the room
 * can offer "Add Elric" when only the date of birth is missing ('age_unknown') and keep it hidden
 * without Google sign-in ('unverified') or under 18. Synthetic data only.
 */
test('the status names the eligibility reason: unverified, age_unknown, then eligible', async (t) => {
  const f = await elricFixture(t);
  const owner = await f.account('Reason Rae');
  const status = async () => {
    const res = await f.call(owner.cookie, 'GET', '/api/elric');
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { eligible: boolean; eligibility_reason: string | null };
  };
  const fresh = await status();
  assert.equal(fresh.eligible, false);
  assert.equal(fresh.eligibility_reason, 'unverified');
  // Google sign-in done, no date of birth yet: Add Elric asks for it.
  await f.db.query(
    `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,verified_at,created_at)
     VALUES($1,'google','sub-reason','rae@example.com',true,$2,$2)`,
    [owner.operatorId, Date.now()],
  );
  const missing = await status();
  assert.equal(missing.eligible, false);
  assert.equal(missing.eligibility_reason, 'age_unknown');

  // A verified adult: eligible, no reason.
  const adult = await f.account('Adult Ada');
  await f.verify(adult);
  const ok = (await f.call(adult.cookie, 'GET', '/api/elric')).json();
  assert.equal(ok.eligible, true);
  assert.equal(ok.eligibility_reason, null);
});
