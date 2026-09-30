import test from 'node:test';
import assert from 'node:assert/strict';
import { STRESS_TEST_COUNT_DISCLOSURE } from '../shared/count-log/disclosure.js';

test('the count disclosure is one plain sentence about stress-test agents', () => {
  assert.equal(
    STRESS_TEST_COUNT_DISCLOSURE,
    "The count includes AI agents created by Central City's own master account for stress tests.",
  );
  assert.match(STRESS_TEST_COUNT_DISCLOSURE, /^[A-Z][^.]*\.$/);
});
