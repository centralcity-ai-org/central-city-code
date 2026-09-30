/*
 * Syntax highlighting for room code blocks. This module is imported
 * lazily, only when a message has a fenced code block, so its grammars stay out of the room
 * chunk. lowlight returns a hast tree, which CodeBlock renders to React spans: no HTML strings.
 *
 * Never use highlight.js's HTML-string API here or anywhere in src/ (`hljs.highlight(...).value`,
 * `highlightAuto`, `highlightElement`, `highlightAll`) or turn the tree into HTML (`hast-util-to-html`):
 * those produce markup from message text. tests/room-markdown.test.ts fails if any appear.
 */
import { createLowlight } from 'lowlight';
import type { Root } from 'hast';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import yaml from 'highlight.js/lib/languages/yaml';

const lowlight = createLowlight({
  bash,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  yaml,
});
// HTML is shown as plain text on purpose (no xml grammar); these are the common extra names.
lowlight.registerAlias({
  bash: ['sh', 'shell', 'zsh', 'console'],
  ini: ['toml'],
  javascript: ['js', 'jsx', 'mjs', 'cjs'],
  typescript: ['ts', 'tsx', 'mts', 'cts'],
  python: ['py'],
  rust: ['rs'],
  yaml: ['yml'],
  markdown: ['md'],
  diff: ['patch'],
});

/** Highlight bounds: very long blocks are shown plain rather than blocking the main thread. */
export const MAX_HIGHLIGHT_CHARS = 20_000;

/** The hast tree for `code` in `language`, or null for an unknown language or oversize block. */
export function highlight(language: string, code: string): Root | null {
  const name = language.trim().toLowerCase();
  if (!name || code.length > MAX_HIGHLIGHT_CHARS || !lowlight.registered(name)) return null;
  return lowlight.highlight(name, code);
}
