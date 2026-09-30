/*
 * Cheap, linear checks that run BEFORE any Markdown parsing. Pathological
 * nesting or delimiter runs overflow the parser's stack or make delimiter resolution take seconds,
 * so such messages are shown as plain text instead. The parse itself also runs in a worker with a
 * hard time budget (workerClient.ts); this guard keeps the common attacks from ever getting there.
 *
 * The nesting and run-length checks apply to EVERY line, fenced code included
 * (a line the guard wrongly took for a fence must not hide the rest). Only the total delimiter
 * count is fence-aware, using CommonMark's fence rules exactly, so ordinary code (snake_case,
 * pointers) never forces plain text.
 */

/** Container markers (`>`, list bullets or numbers) allowed at the start of one line. */
export const MAX_LINE_NESTING = 32;
/** Longest run of one emphasis/link delimiter character (`*`, `_`, `~`, `[`, `]`). */
export const MAX_DELIMITER_RUN = 64;
/** Delimiter characters allowed in a whole message, outside fenced code blocks. */
export const MAX_DELIMITERS = 1_000;

const DELIMITERS = new Set(['*', '_', '~', '[', ']']);

/** CommonMark §4.5: an opening code fence at the start of a (top-level) line, or null. */
export function openingFence(line: string): { char: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const fence = match[1]!;
  const char = fence[0] as '`' | '~';
  // A backtick fence's info string may not contain a backtick (```a` is not a fence).
  if (char === '`' && match[2]!.includes('`')) return null;
  return { char, length: fence.length };
}

/** CommonMark §4.5: does this line close a fence opened with `open`? */
export function closesFence(line: string, open: { char: '`' | '~'; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1]![0] === open.char && match[1]!.length >= open.length);
}

/** True when the text must not be parsed as Markdown (it is rendered as plain text). */
export function tooComplexForMarkdown(text: string): boolean {
  let delimiters = 0;
  let fence: { char: '`' | '~'; length: number } | null = null;
  let start = 0;
  const n = text.length;
  while (start <= n) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? n : newline;
    const line = text.slice(start, end);
    // Fence state (for the delimiter total only).
    let inCode = false;
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      inCode = true;
    } else {
      const opened = openingFence(line);
      if (opened) {
        fence = opened;
        inCode = true;
      }
    }
    // Container prefix: spaces, tabs, '>', and list markers ('-', '+', '*' or 1-9 digits and
    // '.' or ')') followed by whitespace. Checked on every line.
    let nesting = 0;
    let i = 0;
    const m = line.length;
    while (i < m) {
      const c = line[i]!;
      if (c === ' ' || c === '\t') i++;
      else if (c === '>') {
        nesting++;
        i++;
      } else if ((c === '-' || c === '+' || c === '*') && /[ \t]/.test(line[i + 1] ?? '')) {
        nesting++;
        i += 2;
      } else if (c >= '0' && c <= '9') {
        let j = i;
        while (j < m && j - i < 9 && line[j]! >= '0' && line[j]! <= '9') j++;
        if ((line[j] === '.' || line[j] === ')') && /[ \t]/.test(line[j + 1] ?? '')) {
          nesting++;
          i = j + 2;
        } else break;
      } else break;
      if (nesting > MAX_LINE_NESTING) return true;
    }
    // Delimiter runs (every line) and the total (outside fenced code).
    let runChar = '';
    let run = 0;
    for (let k = 0; k < m; k++) {
      const c = line[k]!;
      if (DELIMITERS.has(c)) {
        run = c === runChar ? run + 1 : 1;
        runChar = c;
        if (run > MAX_DELIMITER_RUN) return true;
        if (!inCode && ++delimiters > MAX_DELIMITERS) return true;
      } else {
        runChar = '';
        run = 0;
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return false;
}

/**
 * Bidirectional controls make text read differently from what it is ("Trojan Source"): the
 * overrides and isolates U+202A–U+202E and U+2066–U+2069, and the marks U+200E, U+200F and
 * U+061C. Room messages drop them.
 */
export const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
export function withoutBidiControls(text: string): string {
  return text.replace(BIDI_CONTROLS, '');
}
