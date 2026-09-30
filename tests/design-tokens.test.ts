import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { FOOTER_COLUMNS, LINKS, liveFooterColumns } from '../src/shell/links.js';
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

test('links.ts has docs and footer has Sign up instead of Rooms', () => {
  assert.equal(LINKS.docs, '/docs');
  assert.equal(LINKS.signUp, '/#signin');

  const productCol = FOOTER_COLUMNS.find((col) => col.title === 'Product');
  assert.ok(productCol, 'Product column exists');
  assert.equal(productCol.links[0].label, 'Sign up');
  assert.equal(productCol.links[0].href, '/#signin');

  const live = liveFooterColumns();
  const liveProduct = live.find((col) => col.title === 'Product');
  assert.ok(liveProduct, 'Live product column exists');
  assert.equal(liveProduct.links[0].label, 'Sign up');
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
