import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeError,
  KNOWN_ERROR_CODES,
  parseRetryAfter,
  type ErrorCopy,
} from '../src/ui/errors';

const FORBIDDEN_TEXT = /request fields are invalid/i;
const words = (copy: ErrorCopy) =>
  `${copy.title} ${copy.detail ?? ''}`.trim().split(/\s+/).filter(Boolean).length;

/** Every result: plain, short, never the old generic server string, never server text. */
function assertPlain(copy: ErrorCopy, serverText?: string) {
  assert.ok(copy.title.length > 0);
  assert.ok(
    words(copy) <= 20,
    `too long (${words(copy)} words): ${copy.title} ${copy.detail ?? ''}`,
  );
  assert.doesNotMatch(`${copy.title} ${copy.detail ?? ''}`, FORBIDDEN_TEXT);
  if (serverText) assert.ok(!`${copy.title} ${copy.detail ?? ''}`.includes(serverText));
  assert.equal(typeof copy.retryable, 'boolean');
}

const rest = (status: number, body: unknown, headers?: Record<string, string>) => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  ...(headers ? { headers } : {}),
});
const tool = (error: Record<string, unknown>) => ({
  isError: true,
  content: [{ type: 'text', text: JSON.stringify({ error }) }],
});

// DESIGN_SYSTEM §4.3, exactly.
const TABLE: Array<[string, number, string, string | undefined]> = [
  [
    'invite_invalid',
    404,
    'This invite link is invalid or has expired.',
    'Ask the host for a new link.',
  ],
  ['room_closed', 409, 'This room is closed.', 'Its history stays readable.'],
  ['room_full', 409, 'This room is full.', undefined],
  ['room_storage_full', 429, 'This room has reached its message limit.', undefined],
  ['read_only', 403, 'You can read this room but not post.', undefined],
  ['not_a_member', 403, "You're no longer in this room.", undefined],
  ['removed_from_room', 403, "You're no longer in this room.", undefined],
  ['workspace_paused', 409, 'Your workspace is paused.', 'Resume it to continue.'],
  ['rate_limited', 429, 'Too many messages at once.', 'Try again in a minute.'],
  ['message_too_large', 413, 'This message is too long.', undefined],
  ['too_large', 413, 'This message is too long.', undefined],
  [
    'idempotency_conflict',
    409,
    'This was already sent with different content.',
    'Refresh and try again.',
  ],
  ['connection_required', 403, "Your agent can't message that agent yet.", undefined],
];

test('every §4.3 code maps to its exact copy in REST and MCP tool shapes', () => {
  for (const [code, status, title, detail] of TABLE) {
    for (const input of [
      rest(status, { error: 'Some server sentence.', code }),
      tool({ code, message: 'Some server sentence.', retryable: status === 429 }),
    ]) {
      const copy = describeError(input);
      assert.equal(copy.code, code);
      assert.equal(copy.title, title, code);
      assert.equal(copy.detail, detail, code);
      assertPlain(copy, 'Some server sentence.');
    }
  }
});

test('agent_paused names the agent when known, and cleans the label', () => {
  const body = rest(409, { error: 'Scout is paused.', code: 'agent_paused' });
  assert.equal(describeError(body, { agentName: 'Scout' }).title, 'Scout is paused.');
  assert.equal(describeError(body).title, 'This agent is paused.');
  assert.equal(describeError(body).detail, 'Resume it in Agents.');
  const long = describeError(body, { agentName: `x\u0007${'y'.repeat(80)}` });
  assert.ok(long.title.length < 60 && !long.title.includes('\u0007'));
});

test('400 without a code is the form copy and never "Request fields are invalid"', () => {
  for (const input of [
    rest(400, { error: 'Request fields are invalid.' }),
    { status: 400, message: 'Request fields are invalid.' },
    Object.assign(new Error('Request fields are invalid.'), { status: 400 }),
    tool({ code: 'invalid_arguments', message: 'Tool arguments are invalid.', retryable: false }),
  ]) {
    const copy = describeError(input);
    assert.equal(copy.title, "Something in this form isn't right. Check it and try again.");
    assert.equal(copy.code, 'invalid_arguments');
    assert.equal(copy.retryable, false);
    assertPlain(copy, 'Request fields are invalid.');
  }
});

test('issues[].path becomes the field to mark (string or array paths)', () => {
  assert.equal(
    describeError(rest(400, { error: 'x', issues: [{ path: 'name', message: 'Too short' }] }))
      .field,
    'name',
  );
  assert.equal(
    describeError(rest(400, { error: 'x', issues: [{ path: ['parts', 0, 'text'] }] })).field,
    'parts.0.text',
  );
  assert.equal(
    describeError(rest(400, { error: 'x', issues: [{ message: 'no path' }] })).field,
    undefined,
  );
});

test('quota and approval codes inside issues[] decide over the generic 403/409', () => {
  const quota = describeError(
    tool({
      code: 'conflict',
      message: 'The manifest cannot be applied: QUOTA_EXCEEDED at spec.members.',
      retryable: false,
      issues: [{ code: 'QUOTA_EXCEEDED', path: 'spec.members', message: 'm', hint: 'h' }],
    }),
  );
  assert.equal(quota.code, 'QUOTA_EXCEEDED');
  assert.equal(quota.retryable, false, 'a quota is not a rate limit');
  assert.equal(quota.field, 'spec.members');
  assertPlain(quota, 'QUOTA_EXCEEDED at');

  const approval = describeError(
    rest(403, { error: 'x', issues: [{ code: 'OWNER_APPROVAL_REQUIRED', path: 'spec' }] }),
  );
  assert.equal(approval.code, 'OWNER_APPROVAL_REQUIRED');
  const unclaimed = describeError(
    rest(403, {
      error: 'x',
      issues: [{ code: 'QUOTA_EXCEEDED' }, { code: 'UNCLAIMED_ZERO_COST_ONLY' }],
    }),
  );
  assert.equal(unclaimed.code, 'UNCLAIMED_ZERO_COST_ONLY');
  for (const copy of [approval, unclaimed]) assertPlain(copy);
});

test('401 in every shape asks for sign-in', () => {
  for (const input of [
    rest(401, { error: 'Authentication required.' }),
    rest(401, { error: 'invalid_token', error_description: 'The access token is invalid.' }),
    { status: 401, message: 'Unauthorized' },
    tool({ code: 'authorization_expired', message: 'x', retryable: false }),
  ]) {
    const copy = describeError(input);
    assert.equal(copy.signIn, true, JSON.stringify(input));
    assertPlain(copy);
  }
});

test('429 with Retry-After (seconds or HTTP date, any header casing or Headers object)', () => {
  const seconds = describeError(
    rest(429, { error: 'Too many requests.' }, { 'Retry-After': '30' }),
  );
  assert.equal(seconds.code, 'rate_limited');
  assert.equal(seconds.retryable, true);
  assert.equal(seconds.retryAfterMs, 30_000);
  assertPlain(seconds);

  const now = Date.parse('2026-09-27T10:00:00Z');
  const dated = describeError(
    rest(
      429,
      { error: 'x', code: 'inbox_full' },
      { 'retry-after': 'Sun, 27 Sep 2026 10:01:00 GMT' },
    ),
    { now },
  );
  assert.equal(dated.code, 'inbox_full');
  assert.equal(dated.retryAfterMs, 60_000);

  const headers = new Headers({ 'Retry-After': '5' });
  assert.equal(describeError({ status: 429, headers, body: '' }).retryAfterMs, 5000);

  assert.equal(describeError(rest(429, { error: 'x', retry_after_ms: 1500 })).retryAfterMs, 1500);
  assert.equal(parseRetryAfter('soon'), undefined);
  assert.equal(parseRetryAfter(undefined), undefined);
});

test('room_storage_full is never retryable even though the server marks every 429 retryable', () => {
  const copy = describeError(tool({ code: 'room_storage_full', message: 'x', retryable: true }));
  assert.equal(copy.retryable, false);
});

test('5xx, network failures, timeouts and offline', () => {
  const server = describeError(rest(500, { error: 'The operation could not be completed.' }));
  assert.equal(server.title, "We couldn't reach Central City. Try again.");
  assert.equal(server.retryable, true);
  const network = describeError(new TypeError('Failed to fetch'));
  assert.equal(network.title, "We couldn't reach Central City. Try again.");
  assert.equal(network.retryable, true);
  const abort = describeError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(abort.code, 'timeout');
  const offline = describeError(new TypeError('Failed to fetch'), { offline: true });
  assert.equal(offline.code, 'offline');
  const ask = describeError(rest(503, { error: 'x', code: 'ask_timeout', retry_after_ms: 800 }));
  assert.equal(ask.code, 'ask_timeout');
  assert.equal(ask.retryAfterMs, 800);
  for (const copy of [server, network, abort, offline, ask]) assertPlain(copy);
});

test('HTML, plain text, empty and malformed bodies fall back by status', () => {
  const html = describeError(rest(404, '<!doctype html><title>Not found</title>'));
  assert.equal(html.code, 'not_found');
  const text = describeError(rest(413, 'Request Entity Too Large'));
  assert.equal(text.code, 'too_large');
  const empty = describeError(rest(409, ''));
  assert.equal(empty.code, 'conflict');
  const broken = describeError(rest(400, '{"error": '));
  assert.equal(broken.code, 'invalid_arguments');
  const bad = describeError(rest(502, '<html>Bad gateway</html>'));
  assert.equal(bad.code, 'unreachable');
  for (const copy of [html, text, empty, broken, bad]) assertPlain(copy, 'Not found');
});

test('/mcp transport shapes: plain {error}, OAuth-style and JSON-RPC', () => {
  const origin = describeError(rest(403, { error: 'Cross-origin MCP requests are not allowed.' }));
  assert.equal(origin.code, 'forbidden');
  assertPlain(origin, 'Cross-origin');
  const media = describeError(rest(415, { error: 'Use application/json.' }));
  assert.equal(media.title, "Something in this form isn't right. Check it and try again.");
  const rpc = describeError(
    rest(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch' } }),
  );
  assert.equal(rpc.code, 'protocol_error');
  assertPlain(rpc, 'batch');
  const bare = describeError({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'nope' } });
  assert.equal(bare.code, 'protocol_error');
  const scope = describeError(rest(403, { error: 'insufficient_scope', error_description: 'x' }));
  assert.equal(scope.code, 'insufficient_scope');
  const link = describeError(rest(404, { error: 'link_invalid', message: 'x' }));
  assert.equal(link.title, 'This invite link is invalid or has expired.');
});

test('unknown codes and unknown inputs fall back safely', () => {
  const unknownCode = describeError(
    rest(409, { error: 'Brand new failure.', code: 'brand_new_code' }),
  );
  assert.equal(unknownCode.code, 'conflict');
  assertPlain(unknownCode, 'Brand new failure.');
  const unknownToolCode = describeError(
    tool({ code: 'brand_new_code', message: 'x', retryable: true }),
  );
  assertPlain(unknownToolCode);
  const teapot = describeError(rest(418, { error: 'I am a teapot' }));
  assert.equal(teapot.code, 'client_error');
  assertPlain(teapot, 'teapot');
  for (const input of [undefined, null, 42, 'boom', {}, [], new Error('x')]) {
    const copy = describeError(input);
    assert.equal(copy.code, 'unknown');
    assertPlain(copy);
  }
  const garbageTool = describeError({
    isError: true,
    content: [{ type: 'text', text: 'not json' }],
  });
  assertPlain(garbageTool, 'not json');
});

test('every code with dedicated copy stays within 20 words and is reachable', () => {
  for (const code of KNOWN_ERROR_CODES) {
    const input =
      code === code.toUpperCase()
        ? rest(409, { error: 'x', issues: [{ code }] })
        : rest(code === 'internal_error' ? 500 : 409, { error: 'x', code });
    const copy = describeError(input);
    assertPlain(copy);
    if (code !== 'internal_error' && code !== 'protocol_error') assert.equal(copy.code, code, code);
  }
});
