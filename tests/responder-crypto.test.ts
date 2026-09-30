import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptApiKey, encryptApiKey, rewrapDek } from '../server/responder/crypto.js';
import { deriveKek, responderKeyId, responderKeys } from '../server/responder/keys.js';
import {
  checkKeyFormat,
  mapValidationStatus,
  validationRequest,
} from '../server/responder/providers.js';
import { RESPONDER_MODELS, estimatedCostPerReplyUsd } from '../server/responder/models.js';

/** Hosted responder: envelope encryption, root keys and key checks (synthetic keys only). */
const binding = { id: 'rsk_1', agentId: 'agent-1', ownerId: 'owner-1', provider: 'openai' };
const apiKey = () => Buffer.from(`sk-proj-${'T'.repeat(40)}`);

test('envelope round trip; the ciphertext never contains the key', () => {
  const kek = randomBytes(32);
  const sealed = encryptApiKey(kek, binding, apiKey());
  assert.equal(sealed.ciphertext.includes(apiKey()), false);
  assert.equal(sealed.wrappedDek.length, 12 + 32 + 16);
  assert.deepEqual(decryptApiKey(kek, binding, sealed), apiKey());
  // Fresh nonces and data keys every time.
  const again = encryptApiKey(kek, binding, apiKey());
  assert.notDeepEqual(again.ciphertext, sealed.ciphertext);
  assert.notDeepEqual(again.wrappedDek, sealed.wrappedDek);
});

test('the AAD binds both layers to their row: a moved ciphertext fails', () => {
  const kek = randomBytes(32);
  const sealed = encryptApiKey(kek, binding, apiKey());
  for (const other of [
    { ...binding, id: 'rsk_2' },
    { ...binding, agentId: 'agent-2' },
    { ...binding, ownerId: 'owner-2' },
    { ...binding, provider: 'anthropic' },
  ])
    assert.throws(() => decryptApiKey(kek, other, sealed));
  assert.throws(() => decryptApiKey(randomBytes(32), binding, sealed), 'wrong root key');
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[20]! ^= 1;
  assert.throws(() => decryptApiKey(kek, binding, { ...sealed, ciphertext: tampered }));
});

test('rotation rewraps only the data key', () => {
  const [oldKek, newKek] = [randomBytes(32), randomBytes(32)];
  const sealed = encryptApiKey(oldKek, binding, apiKey());
  const wrappedDek = rewrapDek(oldKek, newKek, binding, sealed.wrappedDek);
  assert.deepEqual(decryptApiKey(newKek, binding, { ...sealed, wrappedDek }), apiKey());
  assert.throws(() => decryptApiKey(oldKek, binding, { ...sealed, wrappedDek }));
});

test('root keys: hosted needs a distinct 32-byte CITY_RESPONDER_KEK; no fallback', () => {
  const kek = randomBytes(32).toString('base64');
  assert.deepEqual(responderKeys({}, { hosted: true }), { available: false, reason: 'missing' });
  assert.deepEqual(responderKeys({ CITY_RATE_LIMIT_KEY: 'x'.repeat(40) }, { hosted: true }), {
    available: false,
    reason: 'missing',
  });
  assert.deepEqual(responderKeys({ CITY_RESPONDER_KEK: 'too-short' }, { hosted: true }), {
    available: false,
    reason: 'invalid',
  });
  for (const name of [
    'CITY_RATE_LIMIT_KEY',
    'CITY_WAKE_SECRET',
    'CITY_SIGNING_KEY',
    'DATABASE_URL',
  ])
    assert.deepEqual(responderKeys({ CITY_RESPONDER_KEK: kek, [name]: kek }, { hosted: true }), {
      available: false,
      reason: 'not_distinct',
    });
  // The same bytes as a hex-encoded other secret are still the same secret.
  const bytes = Buffer.from(kek, 'base64');
  assert.equal(
    responderKeys(
      { CITY_RESPONDER_KEK: kek, CITY_WAKE_SECRET: bytes.toString('hex') },
      { hosted: true },
    ).available,
    false,
  );
  const ok = responderKeys(
    { CITY_RESPONDER_KEK: kek, CITY_RATE_LIMIT_KEY: 'y'.repeat(40) },
    { hosted: true },
  );
  assert.ok(ok.available);
  assert.equal(ok.ephemeral, false);
  // The wrapping key is an HKDF subkey of the configured root, never the root itself (N1).
  assert.deepEqual(ok.current.key, deriveKek(bytes));
  assert.notDeepEqual(ok.current.key, bytes);
  assert.equal(ok.current.kid, responderKeyId(deriveKek(bytes)));
  assert.match(ok.current.kid, /^k_[0-9a-f]{12}$/);
});

test('root keys: rotation keeps the previous key second; locally a random key is used', () => {
  const [a, b] = [randomBytes(32).toString('base64'), randomBytes(32).toString('base64url')];
  const keys = responderKeys(
    { CITY_RESPONDER_KEK: a, CITY_RESPONDER_KEK_PREVIOUS: b },
    { hosted: true },
  );
  assert.ok(keys.available);
  assert.equal(keys.all.length, 2);
  assert.equal(keys.all[0]!.kid, keys.current.kid);
  assert.deepEqual(keys.all[1]!.key, deriveKek(Buffer.from(b, 'base64url')));
  assert.equal(
    responderKeys({ CITY_RESPONDER_KEK: a, CITY_RESPONDER_KEK_PREVIOUS: 'bad' }, { hosted: true })
      .available,
    false,
  );
  const local = responderKeys({}, { hosted: false });
  assert.ok(local.available && local.ephemeral);
});

test('key formats: admin keys refused; only the expected prefixes', () => {
  const k = (text: string) => Buffer.from(text);
  assert.equal(checkKeyFormat('anthropic', k(`sk-ant-api03-${'a'.repeat(30)}`)), 'ok');
  assert.equal(
    checkKeyFormat('anthropic', k(`sk-ant-admin01-${'a'.repeat(30)}`)),
    'unsupported_key',
  );
  assert.equal(checkKeyFormat('anthropic', k(`sk-proj-${'a'.repeat(30)}`)), 'invalid_key_format');
  assert.equal(checkKeyFormat('openai', k(`sk-proj-${'a'.repeat(30)}`)), 'ok');
  assert.equal(checkKeyFormat('openai', k(`sk-admin-${'a'.repeat(30)}`)), 'unsupported_key');
  assert.equal(checkKeyFormat('openai', k('sk-short')), 'invalid_key_format');
  assert.equal(checkKeyFormat('openai', k(`sk-${'a'.repeat(30)} x`)), 'invalid_key_format');
});

test('validation requests go to fixed hosts; statuses map to fixed codes', () => {
  const anthropic = validationRequest('anthropic', 'claude-sonnet-5', 'sk-ant-api-x');
  assert.equal(anthropic.url, 'https://api.anthropic.com/v1/models/claude-sonnet-5');
  assert.equal(anthropic.headers['anthropic-version'], '2023-06-01');
  const openai = validationRequest('openai', 'gpt-6-sol', 'sk-x');
  assert.equal(openai.url, 'https://api.openai.com/v1/models/gpt-6-sol');
  assert.equal(
    validationRequest('openai', '../admin', 'sk-x').url,
    'https://api.openai.com/v1/models/..%2Fadmin',
  );
  assert.deepEqual(mapValidationStatus(200), { ok: true });
  assert.deepEqual(mapValidationStatus(401), { ok: false, code: 'invalid_key' });
  assert.deepEqual(mapValidationStatus(403), { ok: false, code: 'forbidden_key' });
  assert.deepEqual(mapValidationStatus(404), { ok: false, code: 'model_unavailable' });
  for (const status of [0, 302, 429, 500, 529])
    assert.deepEqual(mapValidationStatus(status), { ok: false, code: 'provider_unreachable' });
});

test('every allowlisted model has a price and an estimate', () => {
  for (const model of RESPONDER_MODELS) {
    assert.ok(model.inputMicroUsdPerMTok > 0 && model.outputMicroUsdPerMTok > 0, model.id);
    assert.ok(estimatedCostPerReplyUsd(model) >= 0.01, model.id);
  }
});
