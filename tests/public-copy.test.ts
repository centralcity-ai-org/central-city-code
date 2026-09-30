import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderPublicDocs } from '../scripts/public-docs/build.js';

/**
 * Public copy must be strictly true. These phrases overclaim what is open source, imply an
 * endorsement we do not have, or call the live product unfinished. They are refused in every
 * public page, the public Markdown docs and the AI guides. Code identifiers (variable names,
 * CSS classes, attribute values without spaces) are not copy and are not checked.
 */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bfully open[- ]source(?:d)?\b/i, 'fully open source'],
  [/\b100\s?%\s*open\b/i, '100% open'],
  [/\beverything is open\b/i, 'everything is open'],
  [/\bofficial\b/i, 'official'],
  [/\bcertified\b/i, 'certified'],
  [/\bpartners?\b/i, 'partner'],
  [/\btrusted by\b/i, 'trusted by'],
  [/\bcoming soon\b/i, 'coming soon'],
  [/\bbeta\b/i, 'beta'],
  [/\bpreview\b/i, 'preview'],
  [/\bplugins?\b/i, 'plugin'],
];

/**
 * True statements that contain a forbidden word; each allows only its exact phrase. Vendor terms
 * name another company's own product or menu (for example ChatGPT's Plugins settings), never us.
 */
const ALLOWED: RegExp[] = [
  // Legal pages: transfers to providers certified under the EU-US Data Privacy Framework.
  /\bcertified providers\b/i,
  // ChatGPT's own menu and directory names.
  /\bChatGPT Plugins\b/,
  /\bpersonal plugins\b/i,
  /\bits plugin(?:\s+directory)?$/i,
  /chatgpt\.com\/plugins/i,
];

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Public page sources: the landing page, Downtown, docs, trust pages and the public shell. */
const PAGE_SOURCES = [
  'src/Landing.tsx',
  'src/Downtown.tsx',
  'src/Connect.tsx',
  'src/Trust.tsx',
  'src/docs/DocsPages.tsx',
  'src/shell/PublicHeader.tsx',
  'src/shell/PublicFooter.tsx',
  'src/shell/PhoneMenu.tsx',
  'src/shell/NotFound.tsx',
  ...readdirSync(join(root, 'src/trust'))
    .filter((name) => name.endsWith('.tsx'))
    .map((name) => `src/trust/${name}`),
];

/**
 * The visible text of a TSX file: JSX text and string literals that read as prose (they contain
 * a space). Comments are removed first. Identifiers, CSS classes and attribute values without
 * spaces are code, not copy.
 */
function copyOf(path: string): string[] {
  const code = read(path)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
  const out: string[] = [];
  const strings = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const match of code.matchAll(strings)) {
    const text = match[1] ?? match[2] ?? match[3] ?? '';
    if (/\s/.test(text.trim())) out.push(text);
  }
  // JSX text: between a tag or an expression and the next tag or expression.
  for (const [, text] of code.matchAll(/[>}]([^<>{}]*[A-Za-z][^<>{}]*)[<{]/g)) out.push(text!);
  return out;
}

function problems(name: string, texts: string[]): string[] {
  const found: string[] = [];
  for (const text of texts)
    for (const line of text.split('\n')) {
      const checked = ALLOWED.reduce((value, allowed) => value.replace(allowed, ''), line);
      for (const [pattern, label] of FORBIDDEN)
        if (pattern.test(checked)) found.push(`${name}: ${label}: ${line.trim().slice(0, 160)}`);
    }
  return found;
}

test('public pages never overclaim (open source, endorsements, beta or preview)', () => {
  const found = PAGE_SOURCES.flatMap((path) => problems(path, copyOf(path)));
  assert.deepEqual(found, []);
});

test('the AI guides, Downtown data and public Markdown docs never overclaim', () => {
  const files = [
    'public/llms.txt',
    'public/llms-full.txt',
    'public/downtown.md',
    'public/downtown.json',
  ];
  const found = files.flatMap((path) => problems(path, [read(path)]));
  for (const [path, text] of renderPublicDocs(root)) found.push(...problems(path, [text]));
  assert.deepEqual(found, []);
});

test('the checks catch the phrases and let code identifiers through', () => {
  for (const line of [
    'Central City is fully open source.',
    'Now 100% open.',
    'The official plugin for ChatGPT.',
    'A certified connector.',
    'The official ChatGPT app.',
    'Trusted by thousands.',
    'Rooms: coming soon.',
    'Everything is open.',
    'Install the Central City plugin.',
    'Built with our partner.',
    'Rooms are in beta.',
    'A preview of rooms.',
  ])
    assert.ok(problems('sample', [line]).length > 0, line);
  assert.deepEqual(
    problems('sample', ['Transfers to certified providers under the framework.']),
    [],
  );
  assert.deepEqual(problems('sample', ['Partnerships, press and general questions.']), []);
});
