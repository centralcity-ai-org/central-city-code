import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCatalogEmpty,
  checkNeonTarget,
  checkPgEnvironment,
  databaseIdentity,
  DatabaseGuardError,
  forbiddenIdentities,
  neonEndpointIdFromHost,
  parsePostgresUrl,
  sameIdentity,
  type DatabaseGuardCode,
} from '../scripts/guards/database.js';

// Synthetic hosts and credentials only; these guards never touch the network.
const PROD = 'ep-prod-main-123456';
const host = (id: string, pooler = false) =>
  `${id}${pooler ? '-pooler' : ''}.us-east-2.aws.neon.tech`;
const url = (h: string, query = '?sslmode=verify-full') =>
  `postgresql://load:synthetic@${h}/city${query}`;

const code = (expected: DatabaseGuardCode) => (error: unknown) =>
  error instanceof DatabaseGuardError && error.code === expected;

const target = (id: string, extra: Partial<Parameters<typeof checkNeonTarget>[0]> = {}) =>
  checkNeonTarget({
    targetUrl: url(host(id)),
    disposableEndpoint: id,
    forbidden: { explicit: PROD },
    ...extra,
  });

test('endpoint ids are parsed exactly from direct and pooler hosts, any case', () => {
  assert.equal(neonEndpointIdFromHost(host(PROD)), PROD);
  assert.equal(neonEndpointIdFromHost(host(PROD, true)), PROD);
  assert.equal(neonEndpointIdFromHost(host(PROD).toUpperCase()), PROD);
  assert.equal(neonEndpointIdFromHost(`${host(PROD)}.`), PROD); // trailing dot
  // Newer pooler hostnames carry an extra label.
  assert.equal(neonEndpointIdFromHost(`${PROD}-pooler.c-2.us-east-2.aws.neon.tech`), PROD);
  for (const bad of [
    'neon.tech',
    'ep-x.neon.tech.evil.com',
    'db.example.com',
    'br-abc.us-east-2.aws.neon.tech',
    'ep-.x.aws.neon.tech',
  ])
    assert.equal(neonEndpointIdFromHost(bad), null, bad);
});

test('a production endpoint that is a prefix or suffix of another is not confused with it', () => {
  // Target ids that contain the forbidden id as a prefix / suffix / infix are NOT forbidden...
  for (const id of [`${PROD}7`, `${PROD}-load`, `ep-x-${PROD.slice(3)}`, 'ep-prod-main-12345'])
    assert.equal(target(id).endpointId, id, id);
  // ...and the forbidden id itself is refused in every spelling.
  for (const spelling of [
    PROD,
    PROD.toUpperCase(),
    `${PROD}-pooler`,
    host(PROD),
    host(PROD, true).toUpperCase(),
    url(host(PROD)),
  ])
    assert.throws(
      () => target(PROD, { forbidden: { explicit: spelling } }),
      code('FORBIDDEN_ENDPOINT'),
      spelling,
    );
  // A forbidden entry that is a prefix of the target does not forbid it.
  assert.doesNotThrow(() => target(`${PROD}9`, { forbidden: { explicit: PROD } }));
});

test('the disposable endpoint must match exactly (no substring, no branch id)', () => {
  const id = 'ep-load-br-lucky-dew-a1b2c3';
  for (const partial of [
    'ep-load',
    'lucky-dew',
    'br-lucky-dew-a1b2c3',
    'us-east-2',
    'aws',
    `${id}0`,
  ])
    assert.throws(() => target(id, { disposableEndpoint: partial }), DatabaseGuardError, partial);
  assert.throws(
    () => target(id, { disposableEndpoint: 'br-lucky-dew-a1b2c3' }),
    code('DISPOSABLE_BRANCH_ID'),
  );
  assert.throws(() => target(id, { disposableEndpoint: undefined }), code('DISPOSABLE_MISSING'));
  assert.throws(
    () => target(id, { disposableEndpoint: 'db.example.com' }),
    code('DISPOSABLE_INVALID'),
  );
  assert.equal(target(id, { disposableEndpoint: host(id, true).toUpperCase() }).endpointId, id);
});

test('the pooler form of the target is still the same forbidden endpoint', () => {
  assert.throws(
    () =>
      checkNeonTarget({
        targetUrl: url(host(PROD, true)),
        disposableEndpoint: PROD,
        forbidden: { explicit: host(PROD) },
      }),
    code('FORBIDDEN_ENDPOINT'),
  );
});

test('DATABASE_URL is forbidden automatically; a missing one adds nothing; an unparseable one fails closed', () => {
  const id = 'ep-load-1a2b3c';
  assert.throws(
    () => target(id, { forbidden: { explicit: PROD, databaseUrl: url(host(id, true)) } }),
    code('FORBIDDEN_ENDPOINT'),
  );
  assert.equal(
    target(id, { forbidden: { explicit: PROD, databaseUrl: undefined } }).endpointId,
    id,
  );
  assert.equal(target(id, { forbidden: { explicit: PROD, databaseUrl: '   ' } }).endpointId, id);
  assert.equal(forbiddenIdentities({ explicit: PROD }).length, 1);
  assert.equal(forbiddenIdentities({ explicit: PROD, databaseUrl: url(host(PROD)) }).length, 2);
  for (const broken of [
    'not a url',
    'postgres://',
    'postgresql://u:p@ep-x.aws.neon.tech/db?host=elsewhere',
  ])
    assert.throws(
      () => forbiddenIdentities({ explicit: PROD, databaseUrl: broken }),
      code('DATABASE_URL_UNPARSEABLE'),
      broken,
    );
  // DATABASE_URL never replaces the explicit, mandatory list.
  assert.throws(
    () => forbiddenIdentities({ explicit: '', databaseUrl: url(host(PROD)) }),
    code('FORBIDDEN_LIST_MISSING'),
  );
  assert.throws(() => forbiddenIdentities({ explicit: [' ', ''] }), code('FORBIDDEN_LIST_MISSING'));
  assert.throws(
    () => forbiddenIdentities({ explicit: `${PROD}, br-main-1` }),
    code('FORBIDDEN_ENTRY_INVALID'),
  );
});

test('IPv6 and other non-Neon hosts are compared exactly after normalization', () => {
  const a = databaseIdentity('postgresql://u:p@[2001:DB8:0:0::1]:5432/db');
  const b = databaseIdentity('[2001:db8::1]');
  assert.deepEqual(a, { kind: 'host', host: '[2001:db8::1]' });
  assert.ok(a && b && sameIdentity(a, b));
  const other = databaseIdentity('postgresql://u:p@[2001:db8::10]/db');
  assert.ok(a && other && !sameIdentity(a, other));
  assert.equal(databaseIdentity('2001:db8::1'), null); // unbracketed IPv6 is ambiguous: refused
  assert.deepEqual(databaseIdentity('postgres://u:p@LOCALHOST/db'), {
    kind: 'host',
    host: 'localhost',
  });
  // A DATABASE_URL on an IPv6 or local host is still protected and does not break Neon targets.
  assert.equal(
    target('ep-load-1a2b3c', {
      forbidden: { explicit: PROD, databaseUrl: 'postgres://u:p@[::1]/db' },
    }).endpointId,
    'ep-load-1a2b3c',
  );
  // A target on an IPv6 literal is not a Neon endpoint.
  assert.throws(
    () =>
      checkNeonTarget({
        targetUrl: 'postgres://u:p@[2001:db8::1]/db',
        disposableEndpoint: PROD,
        forbidden: { explicit: PROD },
      }),
    code('TARGET_NOT_NEON'),
  );
});

test('target URLs that could redirect the client are refused', () => {
  const id = 'ep-load-1a2b3c';
  for (const query of [
    '?host=ep-prod-main-123456.us-east-2.aws.neon.tech',
    '?hostaddr=10.0.0.1',
    '?options=x',
    '?sslmode=disable',
    '?sslmode=require&sslmode=require',
  ])
    assert.throws(
      () =>
        checkNeonTarget({
          targetUrl: url(host(id), query),
          disposableEndpoint: id,
          forbidden: { explicit: PROD },
        }),
      code('TARGET_INVALID'),
      query,
    );
  assert.ok(parsePostgresUrl(url(host(id), '?sslmode=verify-full')));
  assert.equal(parsePostgresUrl(`${url(host(id))}#frag`), null);
  assert.equal(parsePostgresUrl('mysql://u:p@h/db'), null);
  assert.throws(
    () =>
      checkNeonTarget({
        targetUrl: undefined,
        disposableEndpoint: id,
        forbidden: { explicit: PROD },
      }),
    code('TARGET_MISSING'),
  );
  // Multiple hosts in one URL are not a valid single hostname.
  assert.throws(
    () =>
      checkNeonTarget({
        targetUrl: `postgresql://u:p@${host(id)},${host(PROD)}/db`,
        disposableEndpoint: id,
        forbidden: { explicit: PROD },
      }),
    /Neon endpoint host|postgres/,
  );
});

test('errors never echo the connection string or its secret', () => {
  const secret = 'SuperSecretPw';
  try {
    checkNeonTarget({
      targetUrl: `postgresql://u:${secret}@${host(PROD)}/db`,
      disposableEndpoint: PROD,
      forbidden: { explicit: PROD },
    });
    assert.fail('expected refusal');
  } catch (error) {
    assert.ok(error instanceof DatabaseGuardError);
    assert.doesNotMatch(String(error.message), new RegExp(secret));
    assert.doesNotMatch(String(error.message), /ep-prod-main/);
  }
});

test('catalog emptiness fails closed', () => {
  assert.doesNotThrow(() =>
    assertCatalogEmpty({
      custom_schema_count: 0,
      relation_count: 0,
      function_count: '0',
      type_count: 0,
    }),
  );
  for (const row of [
    null,
    undefined,
    { custom_schema_count: 0, relation_count: 3, function_count: 0, type_count: 0 },
    { custom_schema_count: '1.5', relation_count: 0, function_count: 0, type_count: 0 },
  ])
    assert.throws(() => assertCatalogEmpty(row as never), code('DATABASE_NOT_EMPTY'));
});

test('explicit forbidden entries must be Neon identities (typos never fail open)', () => {
  // Each of these used to parse as a plain host that could never equal a Neon target.
  for (const entry of [
    'ep-prod-123456.us-east-2',
    'ep-prod-123456.us-east-2.aws.neon.tec',
    'db.internal',
  ])
    assert.throws(
      () => forbiddenIdentities({ explicit: entry }),
      code('FORBIDDEN_ENTRY_INVALID'),
      entry,
    );
  // Reproduction: a trimmed host no longer lets the production endpoint through.
  assert.throws(
    () =>
      checkNeonTarget({
        targetUrl: url(host('ep-prod-123456')),
        disposableEndpoint: 'ep-prod-123456',
        forbidden: { explicit: 'ep-prod-123456.us-east-2' },
      }),
    code('FORBIDDEN_ENTRY_INVALID'),
  );
  // DATABASE_URL may still be any host: it is added automatically, not typed.
  assert.equal(
    forbiddenIdentities({ explicit: PROD, databaseUrl: 'postgres://u:p@db.internal/x' }).length,
    2,
  );
});

test('sslmode=verify-full is required in the URL and PGOPTIONS is refused', () => {
  const id = 'ep-load-1a2b3c';
  for (const query of ['', '?sslmode=require', '?sslmode=verify-ca'])
    assert.throws(
      () =>
        checkNeonTarget({
          targetUrl: url(host(id), query),
          disposableEndpoint: id,
          forbidden: { explicit: PROD },
        }),
      code('TARGET_SSLMODE'),
      query || '(none)',
    );
  assert.doesNotThrow(() => checkPgEnvironment({}));
  assert.doesNotThrow(() => checkPgEnvironment({ PGOPTIONS: '' }));
  assert.throws(
    () => checkPgEnvironment({ PGOPTIONS: `endpoint=${PROD}` }),
    code('PG_ENVIRONMENT'),
  );
});

test('the validated URL string is returned unchanged and frozen', () => {
  const id = 'ep-load-1a2b3c';
  const targetUrl = url(host(id, true));
  const result = checkNeonTarget({
    targetUrl,
    disposableEndpoint: id,
    forbidden: { explicit: PROD },
  });
  assert.equal(result.databaseUrl, targetUrl);
  assert.ok(Object.isFrozen(result));
});
