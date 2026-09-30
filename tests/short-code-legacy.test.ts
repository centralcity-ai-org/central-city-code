import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * #133 kept an unkeyed short_hash fallback so short codes minted before the keyed HMAC kept
 * working for their lifetime (at most 24 hours). From 2026-10-01 every such code has expired:
 * this test then fails until the fallback is removed from the short-code module, the join-link
 * store and the minting collision check.
 */
const REMOVE_AFTER = Date.parse('2026-10-01T00:00:00Z');

test('the legacy unkeyed short-code hash fallback is gone after 2026-10-01', async () => {
  if (Date.now() < REMOVE_AFTER) return;
  for (const file of [
    '../server/links/short-code.ts',
    '../server/links/store.ts',
    '../server/links/service.ts',
  ]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.ok(
      !source.includes('legacyShortCodeHash'),
      `${file} still has the legacy unkeyed short-code fallback: remove it (every such code has expired).`,
    );
  }
});
