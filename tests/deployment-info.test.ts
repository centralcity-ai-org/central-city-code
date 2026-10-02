import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentInfo } from '../api/deployment.js';

test('deployment info: two facts only, isolated only on a preview with the flag', () => {
  assert.deepEqual(deploymentInfo({ VERCEL_ENV: 'production', CITY_PREVIEW_DB_ISOLATED: '1' }), {
    environment: 'production',
    preview_db_isolated: false,
  });
  assert.deepEqual(deploymentInfo({ VERCEL_ENV: 'preview' }), {
    environment: 'preview',
    preview_db_isolated: false,
  });
  assert.deepEqual(deploymentInfo({ VERCEL_ENV: 'preview', CITY_PREVIEW_DB_ISOLATED: '1' }), {
    environment: 'preview',
    preview_db_isolated: true,
  });
  assert.deepEqual(deploymentInfo({ VERCEL_ENV: 'x"<script>' }), {
    environment: 'other',
    preview_db_isolated: false,
  });
  assert.deepEqual(deploymentInfo({}), { environment: 'other', preview_db_isolated: false });
});
