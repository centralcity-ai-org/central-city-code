import test from 'node:test';
import assert from 'node:assert/strict';
import { signedHeaders } from '../connector/signing.js';
import { GOOGLE_SALT_NO_PASSWORD } from '../server/google/routes.js';
import { TERMS_VERSION } from '../shared/terms.js';
import { OWNER, fixture, fullFlow, mcpCall } from './oauth-helpers.js';

/**
 * The onboarding gate (docs/GOOGLE_SIGNIN.md "Onboarding") also holds for credentials issued
 * before it: an account created with Google that has no recorded Terms acceptance cannot use
 * its OAuth/MCP access tokens, assistant grants or agent runtime credentials (403
 * onboarding_required) until it accepts. Every acceptance is kept in an append-only history.
 */
const headers = { 'content-type': 'application/json', 'x-city-request': '1' };
type App = Awaited<ReturnType<typeof fixture>>['app'];
/** The wake API's stream route with a bearer credential (it resolves its own tokens). */
function wake(app: App, token: string, agentId: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v2/stream?agent=${agentId}`,
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  });
}

test('existing tokens of an unaccepted Google account: 403 onboarding_required until it accepts', async (t) => {
  const { app, cookie } = await fixture(t);
  const api = (url: string, body?: unknown) =>
    app.inject({
      method: body === undefined ? 'GET' : 'POST',
      url,
      headers: { ...headers, cookie },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  // Credentials issued while the account was usable.
  const { tokens } = await fullFlow(app);
  const grant = await api('/api/assistant-access', {
    label: 'Synthetic client',
    scopes: ['workspace:read'],
    expiresInDays: 1,
  });
  assert.equal(grant.statusCode, 201, grant.body);
  const agent = await api('/api/agents', {
    name: 'Runtime fixture',
    description: '',
    mode: 'external',
    capability: 'extract',
  });
  assert.equal(agent.statusCode, 201, agent.body);
  const mcp = () => mcpCall(app, tokens.access_token, 'tools/list');
  const assistant = () =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_workspace',
      headers: { ...headers, authorization: `Bearer ${grant.json().token}` },
      payload: '{}',
    });
  const runtime = () => {
    const body = JSON.stringify({ sequence: Date.now() });
    return app.inject({
      method: 'POST',
      url: '/api/runtime/heartbeat',
      payload: body,
      headers: signedHeaders(agent.json().token, 'POST', '/api/runtime/heartbeat', body),
    });
  };
  assert.equal((await mcp()).statusCode, 200);
  assert.equal((await assistant()).statusCode, 200);
  const before = await runtime();
  assert.ok(before.statusCode < 400, before.body);

  // The same account as a Google account that never accepted the Terms (as before the gate).
  await app.city.db.query('UPDATE operators SET salt=$2 WHERE name=$1', [
    OWNER,
    GOOGLE_SALT_NO_PASSWORD,
  ]);
  await app.city.db.query('DELETE FROM account_terms_acceptances');
  for (const [label, call] of [
    ['MCP', mcp],
    ['assistant grant', assistant],
    ['runtime credential', runtime],
  ] as const) {
    const res = await call();
    assert.equal(res.statusCode, 403, `${label}: ${res.body}`);
    assert.equal(res.json().code, 'onboarding_required', label);
  }
  // The wake API (its own token handling): an assistant grant and an OAuth access token.
  for (const [label, token] of [
    ['wake grant', grant.json().token as string],
    ['wake OAuth token', tokens.access_token],
  ] as const) {
    const res = await wake(app, token, agent.json().agent.id);
    assert.equal(res.statusCode, 403, `${label}: ${res.body}`);
    assert.match(res.body, /onboarding_required/, label);
  }

  // Accepting (twice: a later version is a new acceptance) restores access; both are kept.
  for (let i = 0; i < 2; i += 1) {
    const accepted = await api('/api/auth/onboarding', {
      terms_version: TERMS_VERSION,
      accept_terms: true,
    });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  assert.equal((await mcp()).statusCode, 200);
  assert.equal((await assistant()).statusCode, 200);
  assert.ok((await runtime()).statusCode < 400);
  const history = (
    await app.city.db.query<{ version: string }>(
      'SELECT version FROM account_terms_acceptance_history ORDER BY id',
    )
  ).rows;
  // The password sign-up's acceptance, then the two above.
  assert.deepEqual(
    history.map((row) => row.version),
    [TERMS_VERSION, TERMS_VERSION, TERMS_VERSION],
  );
  assert.equal((await app.city.db.query('SELECT 1 FROM account_terms_acceptances')).rows.length, 1);
});

test('an AI workspace key is held while its human co-owner is an unaccepted Google account', async (t) => {
  const { app, cookie } = await fixture(t);
  const created = await app.inject({
    method: 'POST',
    url: '/api/public/workspaces',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'Onboarding AI', idempotency_key: 'onboarding-ai-key-0001' }),
  });
  assert.equal(created.statusCode, 201, created.body);
  const { workspace_key: key, claim_token: claim } = created.json();
  const claimed = await app.inject({
    method: 'POST',
    url: '/api/workspaces/claim',
    headers: { ...headers, cookie },
    payload: JSON.stringify({ claim_token: claim }),
  });
  assert.equal(claimed.statusCode, 200, claimed.body);
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_workspace',
      headers: { ...headers, authorization: `Bearer ${key}` },
      payload: '{}',
    });
  assert.equal((await call()).statusCode, 200);
  await app.city.db.query('UPDATE operators SET salt=$2 WHERE name=$1', [
    OWNER,
    GOOGLE_SALT_NO_PASSWORD,
  ]);
  await app.city.db.query('DELETE FROM account_terms_acceptances');
  const held = await call();
  assert.equal(held.statusCode, 403, held.body);
  assert.equal(held.json().code, 'onboarding_required');
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...headers, cookie },
    payload: JSON.stringify({ terms_version: TERMS_VERSION, accept_terms: true }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await call()).statusCode, 200);
});

test('the acceptance history is append-only in the database', async (t) => {
  const { app } = await fixture(t);
  const db = app.city.db;
  await db.query(
    "INSERT INTO operators(id,name,name_key,password_hash,salt) VALUES('history-op','History op','history op','!','!')",
  );
  await db.query(
    "INSERT INTO account_terms_acceptance_history(operator_id,version,accepted_at) VALUES('history-op',$1,1)",
    [TERMS_VERSION],
  );
  await assert.rejects(
    db.query("UPDATE account_terms_acceptance_history SET version='1999-01-01'"),
    /append-only/,
  );
  await assert.rejects(db.query('DELETE FROM account_terms_acceptance_history'), /append-only/);
  await assert.rejects(db.query('TRUNCATE account_terms_acceptance_history'), /append-only/);
  // Deleting the account itself removes its history (ON DELETE CASCADE).
  await db.query("DELETE FROM operators WHERE id='history-op'");
  // (The fixture owner's own sign-up acceptance stays.)
  const left = await db.query(
    "SELECT 1 FROM account_terms_acceptance_history WHERE operator_id='history-op'",
  );
  assert.equal(left.rows.length, 0);
});

test('the shared check also holds a password account with a Google link and no recorded acceptance', async (t) => {
  const { app, cookie } = await fixture(t);
  const grant = await app.inject({
    method: 'POST',
    url: '/api/assistant-access',
    headers: { ...headers, cookie },
    payload: JSON.stringify({
      label: 'Synthetic client',
      scopes: ['workspace:read'],
      expiresInDays: 1,
    }),
  });
  assert.equal(grant.statusCode, 201, grant.body);
  const call = () =>
    app.inject({
      method: 'POST',
      url: '/api/assistant/tools/city_workspace',
      headers: { ...headers, authorization: `Bearer ${grant.json().token}` },
      payload: '{}',
    });
  const owner = (
    await app.city.db.query<{ id: string }>('SELECT id FROM operators WHERE name=$1', [OWNER])
  ).rows[0]!.id;
  // A password account from before acceptances were recorded, with Google linked.
  await app.city.db.query('DELETE FROM account_terms_acceptances WHERE operator_id=$1', [owner]);
  assert.equal((await call()).statusCode, 200, 'without a Google link it is not gated');
  await app.city.db.query(
    `INSERT INTO elric_verified_identities(operator_id,provider,subject,email,email_verified,hd,verified_at,created_at)
     VALUES($1,'google','100000000000000000555','linked.person@example.com',true,'example.com',1,1)`,
    [owner],
  );
  const held = await call();
  assert.equal(held.statusCode, 403, held.body);
  assert.equal(held.json().code, 'onboarding_required');
  const accepted = await app.inject({
    method: 'POST',
    url: '/api/auth/onboarding',
    headers: { ...headers, cookie },
    payload: JSON.stringify({ terms_version: TERMS_VERSION, accept_terms: true }),
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal((await call()).statusCode, 200);
});
