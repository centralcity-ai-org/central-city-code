import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../server/app.js';
import { ORIGIN, mcpCall } from './oauth-helpers.js';

async function app(t: { after: (fn: () => Promise<unknown>) => void }) {
  const instance = await createApp({ dataDir: ':memory:', startWorkers: false });
  t.after(() => instance.close());
  return instance;
}

const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

test('GET /mcp from a browser returns the HTML connection guide without auth', async (t) => {
  const city = await app(t);
  const res = await city.inject({ method: 'GET', url: '/mcp', headers: { accept: BROWSER } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['cache-control'], 'public, max-age=300');
  assert.equal(
    res.headers.link,
    `<${ORIGIN}/.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"`,
  );
  assert.match(String(res.headers['content-security-policy']), /default-src 'none'/);
  assert.equal(res.headers['www-authenticate'], undefined);
  assert.match(res.body, /^<!doctype html>/);
  assert.match(res.body, /<html lang="en">/);
  assert.ok(res.body.includes(`href="${ORIGIN}/mcp"`));
  assert.ok(res.body.includes(`href="${ORIGIN}/mcp/open"`));
  assert.ok(res.body.includes(`href="${ORIGIN}/.well-known/mcp/server-card.json"`));
  assert.ok(res.body.includes(`href="${ORIGIN}/llms.txt"`));
  assert.ok(!/<script|src=/i.test(res.body), 'no scripts or external assets');
});

test('GET /mcp from a plain fetch returns the Markdown guide', async (t) => {
  const city = await app(t);
  for (const accept of [undefined, '*/*', 'application/json', 'text/markdown']) {
    const res = await city.inject({
      method: 'GET',
      url: '/mcp',
      headers: accept ? { accept } : {},
    });
    assert.equal(res.statusCode, 200, String(accept));
    assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8');
    assert.equal(res.headers.vary, 'Accept');
    assert.match(res.body, /^# Central City MCP endpoint/);
    assert.ok(res.body.includes(`<${ORIGIN}/mcp>`));
    assert.ok(res.body.includes(`<${ORIGIN}/mcp/open>`));
    assert.ok(res.body.includes(`<${ORIGIN}/.well-known/mcp/server-card.json>`));
  }
});

test('GET /mcp/open returns the guide for the no-account endpoint', async (t) => {
  const city = await app(t);
  const md = await city.inject({ method: 'GET', url: '/mcp/open' });
  assert.equal(md.statusCode, 200);
  assert.match(md.body, /^# Central City open MCP endpoint/);
  const html = await city.inject({ method: 'GET', url: '/mcp/open', headers: { accept: BROWSER } });
  assert.equal(html.statusCode, 200);
  assert.match(html.body, /<h1>Central City open MCP endpoint<\/h1>/);
});

test('MCP stream GET and POST without auth keep the OAuth 401 challenge', async (t) => {
  const city = await app(t);
  const challenge = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="workspace:read agents:create rooms:join rooms:host messages:read messages:send"`;
  const sse = await city.inject({
    method: 'GET',
    url: '/mcp',
    headers: { accept: 'text/event-stream' },
  });
  assert.equal(sse.statusCode, 401);
  assert.equal(sse.headers['www-authenticate'], challenge);
  const post = await mcpCall(city, undefined, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(post.statusCode, 401);
  assert.equal(post.headers['www-authenticate'], challenge);
  const del = await city.inject({ method: 'DELETE', url: '/mcp' });
  assert.equal(del.statusCode, 401);
  // The stream check ignores case, and any credential keeps the normal token check.
  const upper = await city.inject({
    method: 'GET',
    url: '/mcp',
    headers: { accept: 'TEXT/EVENT-STREAM' },
  });
  assert.equal(upper.statusCode, 401);
  const bearer = await city.inject({
    method: 'GET',
    url: '/mcp',
    headers: { accept: 'text/html', authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(bearer.statusCode, 401);
  assert.match(String(bearer.headers['www-authenticate']), /^Bearer /);
});

test('HEAD /mcp answers like the guide without a body', async (t) => {
  const city = await app(t);
  const head = await city.inject({ method: 'HEAD', url: '/mcp', headers: { accept: 'text/html' } });
  assert.equal(head.statusCode, 200);
  assert.match(String(head.headers['content-type']), /^text\/html/);
  assert.equal(head.body, '');
});
