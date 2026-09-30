import { WAKE_LIMITS } from './contract.js';

/**
 * @mention parsing (docs/WAKE.md). Candidates are only the agents that can already read
 * the message (the recipient of a direct message; the active members of a room), so a mention
 * never grants access. Matching is ambiguity-safe: a mention that fits two different agents
 * equally well mentions neither.
 *
 * Accepted forms, case-insensitive: `@<agent id>`, `@<slug>` (the display name lowercased with
 * every run of other characters turned into `-`, e.g. `@city-desk`), `@<display name>` (longest
 * match wins, e.g. `@Build Desk`), and `@"<display name>"`. An `@` preceded by a letter, digit or
 * one of `._-+` (an email address) is not a mention.
 */
export interface MentionCandidate {
  id: string;
  name: string;
}
export interface MentionMatch {
  /** Distinct mentioned agent ids, in order of first mention, at most mentionsPerMessage. */
  ids: string[];
  /** Offset of each agent's first mention (for excerpts). */
  offsets: Map<string, number>;
  /** Mention texts that fit several agents and were ignored. */
  ambiguous: string[];
}

const WORD = /[\p{L}\p{N}_]/u;
const SLUG_CHAR = /[\p{L}\p{N}._-]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const fold = (value: string) => value.normalize('NFKC').toLowerCase();

export function slugOf(name: string): string {
  return fold(name)
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

export function findMentions(
  text: string,
  candidates: readonly MentionCandidate[],
  options: { exclude?: string; max?: number } = {},
): MentionMatch {
  const max = options.max ?? WAKE_LIMITS.mentionsPerMessage;
  // The sender stays a candidate so "@its-own-name" resolves to it (and is then dropped)
  // instead of falling back to a shorter name that happens to be a prefix.
  const pool = candidates
    .map((item) => ({ id: item.id, name: fold(item.name).trim(), slug: slugOf(item.name) }))
    .filter((item) => item.slug.length > 0);
  const result: MentionMatch = { ids: [], offsets: new Map(), ambiguous: [] };
  if (!pool.length || !text.includes('@')) return result;
  const folded = fold(text);
  let scanned = 0;
  for (let at = folded.indexOf('@'); at >= 0; at = folded.indexOf('@', at + 1)) {
    if (++scanned > WAKE_LIMITS.mentionScan || result.ids.length >= max) break;
    const before = at > 0 ? folded[at - 1]! : '';
    if (before && (WORD.test(before) || '.-+'.includes(before))) continue;
    const rest = folded.slice(at + 1, at + 1 + 200);
    let hits: string[] = [];
    let label = '';
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end < 1) continue;
      label = rest.slice(1, end).trim();
      hits = pool.filter((item) => item.name === label).map((item) => item.id);
    } else if (UUID.test(rest) && !WORD.test(rest[36] ?? '')) {
      label = rest.slice(0, 36);
      hits = pool.filter((item) => item.id.toLowerCase() === label).map((item) => item.id);
    } else {
      // Longest display-name prefix ending at a word boundary, or an exact slug token.
      let best = 0;
      for (const item of pool) {
        const length = item.name.length;
        const next = rest[length] ?? '';
        if (length && rest.startsWith(item.name) && !WORD.test(next) && next !== '-') {
          if (length > best) {
            best = length;
            hits = [item.id];
          } else if (length === best) hits.push(item.id);
        }
      }
      let token = '';
      for (const char of rest) {
        if (!SLUG_CHAR.test(char)) break;
        token += char;
      }
      token = token.replace(/[._-]+$/, '');
      const slugHits = token ? pool.filter((item) => item.slug === token) : [];
      if (slugHits.length && token.length >= best) {
        if (token.length > best) hits = slugHits.map((item) => item.id);
        else hits = [...new Set([...hits, ...slugHits.map((item) => item.id)])];
        best = token.length;
      }
      label = rest.slice(0, best);
    }
    const distinct = [...new Set(hits)];
    if (distinct.length > 1) {
      result.ambiguous.push(label);
      continue;
    }
    const id = distinct[0];
    if (!id || id === options.exclude || result.offsets.has(id)) continue;
    result.ids.push(id);
    result.offsets.set(id, at);
  }
  return result;
}

/** Text of all text parts, joined with blank lines. */
export function textOf(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text!)
    .join('\n\n');
}

/** Up to excerptChars characters around a mention (single line). */
export function excerptAt(text: string, offset: number): string {
  const size = WAKE_LIMITS.excerptChars;
  const start = Math.max(0, Math.min(offset - 80, text.length - size));
  const slice = [...text.slice(start, start + size + 16)].slice(0, size).join('');
  return `${start > 0 ? '…' : ''}${slice.replace(/\s+/g, ' ').trim()}${start + size < text.length ? '…' : ''}`;
}
