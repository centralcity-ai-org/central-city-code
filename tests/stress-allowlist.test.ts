import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { createApp } from '../server/app.js';
import type { CityLimits } from '../server/limits.js';
import {
  STRESS_TEST_MAX_GUESTS_DEFAULT,
  STRESS_TEST_MAX_GUESTS_ENV,
  STRESS_TEST_OPERATORS_ENV,
  stressTestMaxGuests,
  isStressTestHost,
  stressTestOperators,
} from '../server/stress-allowlist.js';

process.env.CITY_INVITE_FLOW = '1';
process.env.CITY_RATE_LIMIT_KEY ??= 'synthetic-stress-allowlist-test-secret-00';

/**
 * Stress-test operators: guests joining rooms of an allowlisted host skip the per-source, site,
 * network and region unclaimed caps; the deployment-wide caps and the room member cap still
 * apply, and every other host keeps the public limits. Synthetic data.
 */
test('the allowlist is read from CITY_STRESS_TEST_OPERATORS; empty or absent exempts nobody', () => {
  assert.equal(STRESS_TEST_OPERATORS_ENV, 'CITY_STRESS_TEST_OPERATORS');
  assert.equal(stressTestOperators({}).size, 0);
  assert.equal(stressTestOperators({ CITY_STRESS_TEST_OPERATORS: '' }).size, 0);
  assert.equal(stressTestOperators({ CITY_STRESS_TEST_OPERATORS: ' , ,' }).size, 0);
  assert.deepEqual(
    [...stressTestOperators({ CITY_STRESS_TEST_OPERATORS: ' op-a ,op-b,,bad id,op-a ' })],
    ['op-a', 'op-b'],
  );
  const env = { CITY_STRESS_TEST_OPERATORS: 'op-a,op-b' };
  assert.equal(isStressTestHost('op-a', env), true);
  assert.equal(isStressTestHost('op-c', env), false);
  assert.equal(isStressTestHost('', env), false);
  assert.equal(isStressTestHost(null, env), false);
  assert.equal(isStressTestHost('op-a', {}), false);
  assert.equal(stressTestMaxGuests({}), STRESS_TEST_MAX_GUESTS_DEFAULT);
  assert.equal(STRESS_TEST_MAX_GUESTS_DEFAULT, 50_000);
  assert.equal(stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: '25' }), 25);
  assert.throws(() => stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: 'lots' }));
  assert.throws(() => stressTestMaxGuests({ CITY_STRESS_TEST_MAX_GUESTS: '0' }));
});

const ORIGIN = 'https://centralcity.ai';
const headers = {
  'content-type': 'application/json',
  'x-city-request': '1',
  host: 'centralcity.ai',
  origin: ORIGIN,
};
/** Every guest joins from this one machine. */
const GUEST_ADDRESS = '203.0.113.12';

async function setup(t: TestContext, limits: Partial<CityLimits> = {}) {
  for (const name of [STRESS_TEST_OPERATORS_ENV, STRESS_TEST_MAX_GUESTS_ENV]) {
    const previous = process.env[name];
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  const app = await createApp({
    database: await PGlite.create('memory://'),
    hosted: {
      databaseUrl: 'postgres://unused.invalid/test',
      publicOrigin: ORIGIN,
      allowedOrigins: [ORIGIN],
    },
    startWorkers: false,
    limits,
  });
  t.after(() => app.close());
  let hostAddress = 40;
  const post = (url: string, body: unknown, extra = {}, remoteAddress = GUEST_ADDRESS) =>
    app.inject({
      method: 'POST',
      url,
      headers: { ...headers, ...extra },
      payload: JSON.stringify(body),
      remoteAddress,
    });
  const host = async (name: string, memberCap?: number) => {
    const address = `203.0.113.${hostAddress++}`;
    const registered = await post(
      '/api/auth/register',
      { name, password: 'Synthetic stress test password' },
      {},
      address,
    );
    assert.equal(registered.statusCode, 201, registered.body);
    const cookie = `cc_session=${registered.cookies.find((c) => c.name === 'cc_session')!.value}`;
    const agent = await post(
      '/api/agents',
      { name: `${name} agent`, capability: 'research', mode: 'hosted' },
      { cookie },
      address,
    );
    const room = async (cap?: number) => {
      const created = await post(
        '/api/rooms',
        {
          name: `${name} room`,
          agent_id: agent.json().agent.id,
          idempotency_key: randomUUID(),
          ...(cap ? { member_cap: cap } : {}),
        },
        { cookie },
        address,
      );
      assert.equal(created.statusCode, 201, created.body);
      const roomId = created.json().room.id as string;
      const link = await post(
        '/api/links',
        { target: 'room', room_id: roomId },
        { cookie },
        address,
      );
      assert.equal(link.statusCode, 201, link.body);
      return { roomId, code: (link.json().url as string).split('/j/')[1]! };
    };
    const operatorId = (
      await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [name])
    ).rows[0]!.id;
    return { operatorId, main: await room(memberCap), room };
  };
  let guest = 0;
  const bootstrap = (code: string) => post('/api/public/invites/bootstrap', { code });
  const join = async (code: string, address = GUEST_ADDRESS) => {
    const start = await post('/api/public/invites/bootstrap', { code }, {}, address);
    if (start.statusCode !== 200) return start;
    return post(
      '/api/public/invites/redeem',
      { code, handle: start.json().handle, name: `Guest ${++guest}` },
      {},
      address,
    );
  };

  const stress = await host('Stress host');
  const other = await host('Public host');
  process.env[STRESS_TEST_OPERATORS_ENV] = `unrelated-operator, ${stress.operatorId}`;
  return { app, post, host, join, bootstrap, stress, other };
}

test('guests of a stress-test host skip the unclaimed caps, not the room cap or its ceiling', async (t) => {
  const { app, join, stress, other } = await setup(t, {
    // Tiny per-address caps so a handful of guests reaches them.
    unclaimedAgentsPerSource: 2,
    unclaimedAgentsPerSite: 2,
    unclaimedAgentsPerNetwork: 2,
    unclaimedAgentsPerRegion: 2,
    unclaimedCreatesPerSourcePerHour: 4,
    unclaimedCreatesPerSitePerHour: 4,
    unclaimedCreatesPerNetworkPerHour: 4,
    unclaimedCreatesPerRegionPerHour: 4,
    unclaimedAgentsGlobal: 11,
  });

  // Another host's room keeps the public per-address limits: the third guest is refused.
  for (let i = 0; i < 2; i++) assert.equal((await join(other.main.code)).statusCode, 200);
  assert.equal((await join(other.main.code)).statusCode, 429);

  // The stress host's room admits more guests from the same machine.
  for (let i = 0; i < 6; i++) {
    const joined = await join(stress.main.code);
    assert.equal(joined.statusCode, 200, `stress guest ${i + 1}: ${joined.body}`);
  }
  // Nothing was added to the machine's real site, network or region counters.
  const stats = (
    await app.city.db.query<{ scope_key: string; agents: number }>(
      'SELECT scope_key, agents FROM unclaimed_stats ORDER BY scope_key',
    )
  ).rows;
  assert.equal(stats.find((row) => row.scope_key === 'global')?.agents, 8);
  for (const row of stats.filter((item) => item.scope_key !== 'global'))
    assert.equal(row.agents, 2, `${row.scope_key} counts only the public host's guests`);

  // The room member cap still applies to a stress host's room (host plus two guests).
  const small = await stress.room(3);
  for (let i = 0; i < 2; i++) assert.equal((await join(small.code)).statusCode, 200);
  const full = await join(small.code);
  assert.equal(full.statusCode, 404, full.body);
  assert.equal(full.json().code, 'invite_invalid', 'a full room admits nobody');

  // The deployment-wide cap (11) binds the public host, not the stress host.
  for (let i = 0; i < 2; i++) assert.equal((await join(stress.main.code)).statusCode, 200);
  const global = await join(other.main.code, '198.51.100.7');
  assert.equal(global.statusCode, 409, global.body);
  assert.equal(global.json().code, 'unclaimed_capacity');

  // The stress host's own ceiling: live guests across its rooms (10 so far).
  process.env[STRESS_TEST_MAX_GUESTS_ENV] = '11';
  assert.equal((await join(stress.main.code)).statusCode, 200);
  const ceiling = await join(stress.main.code);
  assert.equal(ceiling.statusCode, 429, ceiling.body);
  assert.equal(ceiling.json().code, 'stress_test_capacity');

  // With the allowlist emptied, the stress host's room is back to the public limits.
  process.env[STRESS_TEST_OPERATORS_ENV] = '';
  assert.equal((await join(stress.main.code)).statusCode, 429);
});

test('a stress-test host lifts the per-code and per-source pickup bounds; others keep them', async (t) => {
  const { bootstrap, stress, other } = await setup(t);
  // Another host's link: at most 100 live pickups per code (and per source) in 10 minutes.
  for (let i = 0; i < 100; i++) {
    const picked = await bootstrap(other.main.code);
    assert.equal(picked.statusCode, 200, `public pickup ${i + 1}: ${picked.body}`);
  }
  const refused = await bootstrap(other.main.code);
  assert.equal(refused.statusCode, 429, refused.body);
  assert.equal(refused.json().code, 'invite_capacity');
  // The stress host's link from the same machine goes past both bounds.
  for (let i = 0; i < 120; i++) {
    const picked = await bootstrap(stress.main.code);
    assert.equal(picked.statusCode, 200, `stress pickup ${i + 1}: ${picked.body}`);
  }
});

test('guests of a stress-test host each get their own activity budget; others share one', async (t) => {
  const { app, join, stress, other } = await setup(t);
  const credentials = async (code: string) => {
    const tokens: string[] = [];
    for (let i = 0; i < 2; i++) {
      const joined = await join(code);
      assert.equal(joined.statusCode, 200, joined.body);
      tokens.push(joined.json().credential as string);
    }
    return tokens;
  };
  let address = 0;
  const members = (token: string) =>
    app.inject({
      method: 'POST',
      url: '/api/public/invites/tools/city_room_members',
      headers: { ...headers, authorization: `Bearer ${token}` },
      payload: '{}',
      // Spread over addresses: only the host's guest activity budget is under test.
      remoteAddress: `198.51.100.${(address++ % 200) + 1}`,
    });
  // Another host: 120 guest calls per minute across all its guests.
  const shared = await credentials(other.main.code);
  for (let i = 0; i < 120; i++)
    assert.equal((await members(shared[i % 2]!)).statusCode, 200, `public call ${i + 1}`);
  assert.equal((await members(shared[0]!)).statusCode, 429);
  // The stress host: 120 per minute for each guest, so two guests make 140 calls.
  const own = await credentials(stress.main.code);
  for (let i = 0; i < 140; i++)
    assert.equal((await members(own[i % 2]!)).statusCode, 200, `stress call ${i + 1}`);
});
