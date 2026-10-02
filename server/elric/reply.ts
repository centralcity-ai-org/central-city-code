import type { Transaction as Tx } from '../database.js';
import { partsContainCredential } from '../rooms/contract.js';

/**
 * What Elric may post (docs/ELRIC.md):
 *
 * - no live @mentions: an Elric reply never pages a member or wakes an agent (its messages carry
 *   no responder stamp yet, so this is also the loop protection toward hosted responders);
 * - [#seq] citations only to messages that exist in THIS room and that Elric can see; others are
 *   stripped;
 * - never a credential: Central City credential prefixes (the room post path refuses them too)
 *   and common model-provider key shapes.
 */
const PROVIDER_KEY = /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,})/;

export function containsCredential(text: string): boolean {
  return partsContainCredential([{ type: 'text', text }]) || PROVIDER_KEY.test(text);
}

/**
 * "@Name" → "Name" wherever the room's mention parser would read a mention (not e-mail). The
 * text is NFKC-normalised first, the same folding the parser applies, so look-alikes such as
 * "＠" (U+FF20) and "﹫" (U+FE6B) become "@" and are stripped too.
 */
export function stripMentions(text: string): string {
  let out = text.normalize('NFKC');
  for (let before = ''; before !== out;) {
    before = out;
    out = out.replace(/(^|[^\p{L}\p{N}_.+-])@+/gu, '$1');
  }
  return out;
}

const CITATION = /\[#(\d{1,15})\]/g;

/** Keeps [#seq] only for messages of this room with visibleFromSeq < seq <= upToSeq. */
export async function validateCitations(
  q: Pick<Tx, 'query'>,
  roomId: string,
  text: string,
  visibleFromSeq: number,
  upToSeq: number,
): Promise<{ text: string; kept: number[]; stripped: number[] }> {
  const cited = [...new Set([...text.matchAll(CITATION)].map((match) => Number(match[1])))];
  if (!cited.length) return { text, kept: [], stripped: [] };
  const candidates = cited.filter((seq) => seq > visibleFromSeq && seq <= upToSeq);
  const found = candidates.length
    ? new Set(
        (
          await q.query<{ seq: string | number }>(
            'SELECT seq FROM room_messages WHERE room_id=$1 AND seq = ANY($2::bigint[])',
            [roomId, candidates],
          )
        ).rows.map((row) => Number(row.seq)),
      )
    : new Set<number>();
  const stripped = cited.filter((seq) => !found.has(seq));
  const cleaned = text
    .replace(CITATION, (match, seq: string) => (found.has(Number(seq)) ? match : ''))
    .replace(/[ \t]+([.,;:!?)])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ');
  return { text: cleaned, kept: cited.filter((seq) => found.has(seq)), stripped };
}
