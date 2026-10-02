import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('vercel.json: HTML is revalidated (no-cache); assets and API paths untouched', () => {
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const cacheFor = (path: string) => {
    let value: string | undefined;
    for (const rule of vercel.headers)
      if (new RegExp(`^${rule.source}$`).test(path))
        for (const h of rule.headers) if (h.key.toLowerCase() === 'cache-control') value = h.value;
    return value;
  };
  for (const path of ['/', '/index.html', '/rooms/abc', '/settings', '/privacy'])
    assert.equal(cacheFor(path), 'no-cache', path);
  assert.equal(cacheFor('/assets/index-abc123.js'), undefined);
  for (const path of ['/api/elric', '/mcp', '/mcp/open', '/oauth/token', '/j/abc', '/a2a/x'])
    assert.equal(cacheFor(path), undefined, path);
  assert.equal(cacheFor('/llms.txt'), 'public, max-age=3600', 'specific rules still win');
});
