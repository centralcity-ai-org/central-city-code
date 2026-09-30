import { test, expect } from '@playwright/test';

/*
 * A trailing slash never 404s (T24): /path/ redirects to /path (308, query kept), the same rule in
 * vercel.json and the local server (shared/routes.ts TRAILING_SLASH_REDIRECT). Server-owned paths
 * keep their exact form.
 */
test('a trailing slash lands on the page without it', async ({ page }) => {
  for (const [from, to, heading] of [
    ['/connect/', '/connect', /./],
    ['/docs/', '/docs', /./],
    ['/about/?ref=footer', '/about?ref=footer', /./],
  ] as const) {
    const response = await page.goto(from);
    expect(response?.status(), from).toBe(200);
    const url = new URL(page.url());
    expect(`${url.pathname}${url.search}`, from).toBe(to);
    await expect(page.getByRole('heading', { level: 1 }).first(), from).toHaveText(heading);
    await expect(page.getByText('This page doesn’t exist.'), from).toHaveCount(0);
  }
});

test('API and protocol paths are not redirected', async ({ request }) => {
  for (const path of ['/api/session', '/.well-known/jwks.json']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
  }
  for (const path of ['/api/session/', '/.well-known/jwks.json/', '/mcp/']) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).not.toBe(308);
    expect(response.headers()['location'], path).toBeUndefined();
  }
});
