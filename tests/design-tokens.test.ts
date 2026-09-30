import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  FOOTER_COLUMNS,
  LINKS,
  NAV_GROUPS,
  PUBLIC_REPOS,
  liveFooterColumns,
} from '../src/shell/links.js';
import {
  THEME_STORAGE_KEY,
  getEffectiveTheme,
  getStoredThemePreference,
} from '../src/shell/theme.js';

/*
 * Design Tokens & Theme Foundation Tests (T4 / PR1)
 * Validates that all v8 foundation tokens, theme controller, and links
 * are properly declared and functional.
 */

test('tokens.css contains all required v8 foundation tokens', () => {
  const cssPath = resolve(process.cwd(), 'src/shell/tokens.css');
  const css = readFileSync(cssPath, 'utf8');

  // Foundation background and surface tokens
  const bgTokens = [
    '--bg-page',
    '--bg-surface',
    '--bg-surface-elevated',
    '--bg-surface-hover',
    '--bg-surface-active',
    '--bg-inset',
  ];
  for (const token of bgTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Foundation border tokens
  const borderTokens = ['--border', '--border-subtle', '--border-strong', '--border-focus'];
  for (const token of borderTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Foundation typography & text tokens
  const textTokens = ['--text-primary', '--text-secondary', '--text-muted', '--text-inverse'];
  for (const token of textTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Precision Central Blue accent tokens
  const accentTokens = [
    '--accent',
    '--accent-hover',
    '--accent-active',
    '--accent-subtle',
    '--accent-border',
    '--accent-text',
    '--accent-contrast',
  ];
  for (const token of accentTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Status indicators
  const statusTokens = [
    '--status-live',
    '--status-live-bg',
    '--status-pending',
    '--status-pending-bg',
    '--status-danger',
    '--status-danger-bg',
  ];
  for (const token of statusTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Apple/OpenAI restraint shadows
  const shadowTokens = [
    '--shadow-sm',
    '--shadow-card',
    '--shadow-elevated',
    '--shadow-floating',
    '--shadow-xl',
  ];
  for (const token of shadowTokens) {
    assert.ok(css.includes(token), `tokens.css missing ${token}`);
  }

  // Nav and bubble tokens
  assert.ok(css.includes('--nav-bg'), 'tokens.css missing --nav-bg');
  assert.ok(css.includes('--nav-border'), 'tokens.css missing --nav-border');
  assert.ok(css.includes('--room-bubble'), 'tokens.css missing --room-bubble');

  // Light by default: dark comes only from the chosen theme attribute, never the OS setting
  assert.ok(
    !css.includes('prefers-color-scheme: dark'),
    'tokens.css must not follow the OS dark-mode setting',
  );
  assert.ok(css.includes("[data-theme='dark']"), 'tokens.css missing data-theme="dark" selector');
});

test('tokens.css preserves backwards-compatible component roles', () => {
  const cssPath = resolve(process.cwd(), 'src/shell/tokens.css');
  const css = readFileSync(cssPath, 'utf8');

  const legacyRoles = [
    '--canvas',
    '--surface',
    '--surface-sunken',
    '--surface-raised',
    '--text',
    '--primary',
    '--primary-hover',
    '--on-primary',
    '--link',
    '--focus',
    '--font-sans',
    '--font-mono',
    '--radius-s',
    '--radius-m',
    '--radius-l',
  ];
  for (const role of legacyRoles) {
    assert.ok(css.includes(role), `tokens.css missing legacy role ${role}`);
  }
});

test('theme controller exports and default behavior', () => {
  assert.equal(THEME_STORAGE_KEY, 'cc-theme');
  assert.equal(getStoredThemePreference(), 'system');
  assert.equal(getEffectiveTheme('dark'), 'dark');
  assert.equal(getEffectiveTheme('light'), 'light');
});

test('links.ts has docs, and the footer mirrors the header groups, then Help & legal', () => {
  assert.equal(LINKS.docs, '/docs');
  assert.equal(LINKS.signUp, '/#signin');

  assert.deepEqual(
    FOOTER_COLUMNS.map((col) => col.title),
    [...NAV_GROUPS.map((group) => group.label), 'Help & legal'],
  );
  const productCol = FOOTER_COLUMNS.find((col) => col.title === 'Product');
  assert.ok(productCol, 'Product column exists');
  assert.deepEqual(productCol.links, NAV_GROUPS[0]!.items);
  assert.equal(productCol.links[0]!.label, 'Workspace');

  const live = liveFooterColumns();
  const liveProduct = live.find((col) => col.title === 'Product');
  assert.ok(liveProduct, 'Live product column exists');
  assert.equal(liveProduct.links[0]!.label, 'Workspace');
  const legal = live.find((col) => col.title === 'Help & legal');
  assert.ok(
    legal?.links.some((link) => link.href === '/imprint'),
    'Imprint stays linked',
  );
});

test('every external header and footer link is one of the public GitHub repositories', () => {
  const links = [
    ...NAV_GROUPS.flatMap((group) => group.items),
    ...FOOTER_COLUMNS.flatMap((column) => column.links),
  ];
  const external = links.filter((link) => link.href && !link.href.startsWith('/'));
  assert.ok(external.length > 0);
  for (const link of external) {
    assert.equal(link.external, true, `${link.label} opens in a new tab`);
    assert.ok(
      PUBLIC_REPOS.some((repo) => link.href === repo || link.href!.startsWith(`${repo}/`)),
      `${link.label}: ${link.href} is not an allowed public repository`,
    );
  }
  // Only these repositories, and all of them public GitHub URLs of the organization.
  for (const repo of PUBLIC_REPOS)
    assert.match(repo, /^https:\/\/github\.com\/centralcity-ai\/[a-z-]+$/);
  // Same-site links never claim to be external.
  for (const link of links.filter((item) => item.href?.startsWith('/')))
    assert.notEqual(link.external, true, link.label);
});

test('no token is defined as a reference to itself', () => {
  const css = readFileSync(new URL('../src/shell/tokens.css', import.meta.url), 'utf8');
  const aliases = [...css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g)];
  // Guard the guard: the file has plenty of token-to-token aliases, so a pattern that matches
  // nothing is broken, not clean.
  assert.ok(aliases.length > 0, 'expected token aliases in tokens.css');
  const selfRefs = aliases.filter((m) => m[1] === m[2]).map((m) => m[1]);
  assert.deepEqual(selfRefs, []);
});
