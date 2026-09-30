import test from 'node:test';
import assert from 'node:assert/strict';
import { withoutRewriteParameter } from '../api/index.js';

test('the Vercel rewrite parameter is removed and every other query byte is kept', () => {
  assert.equal(
    withoutRewriteParameter('/api/messages/conversations?path=messages%2Fconversations'),
    '/api/messages/conversations',
  );
  assert.equal(
    withoutRewriteParameter('/api/messages/conversations?path=messages/conversations'),
    '/api/messages/conversations',
  );
  assert.equal(
    withoutRewriteParameter('/api/agents/a1/inbox?since=0&limit=20&path=agents%2Fa1%2Finbox'),
    '/api/agents/a1/inbox?since=0&limit=20',
  );
  assert.equal(
    withoutRewriteParameter('/api/x?path=x&b=%2B%20c'),
    '/api/x?b=%2B%20c',
    'other parameters keep their exact encoding (signed runtime requests)',
  );
  assert.equal(withoutRewriteParameter('/oauth/token?path=token'), '/oauth/token');
  assert.equal(withoutRewriteParameter('/a2a/abc/tasks?path=abc%2Ftasks'), '/a2a/abc/tasks');
});

test('anything that is not the rewritten tail is left untouched', () => {
  assert.equal(withoutRewriteParameter('/api/messages/summary'), '/api/messages/summary');
  assert.equal(withoutRewriteParameter('/api/files?path=other'), '/api/files?path=other');
  assert.equal(withoutRewriteParameter('/mcp?path=mcp'), '/mcp?path=mcp');
  assert.equal(withoutRewriteParameter('/index.html?path=x'), '/index.html?path=x');
  assert.equal(withoutRewriteParameter('/api/a?path=%E0%A4%A'), '/api/a?path=%E0%A4%A');
});
