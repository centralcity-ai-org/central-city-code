import { normalizeShortCode } from './short-code.js';

/**
 * Forgiving reading of what a person or an AI pasted as an invitation (live test,
 * 2026-09-29): surrounding spaces, a trailing slash, a missing https://, a www. host and a link
 * inside a sentence ("Join my room: https://centralcity.ai/j/7K4M-Q9XP.") all resolve to the
 * same code. Nothing here is fetched; only the code is passed on, and query strings, fragments on
 * /j/ links, user info and other hosts are still refused.
 */
export const PASTE_HINT =
  'This is not a valid invite code: paste the invite link or its 8-character short code.';
/** Longest pasted text accepted (a sentence around a link). */
export const MAX_PASTE_LENGTH = 2048;

const JOIN_CODE = /^[A-Za-z0-9_-]{43}$/;
const REJOIN_CODE = /^rejoin\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,12}\.[A-Za-z0-9_-]{43}$/;
/**
 * The first /j/ or /r/ link in a text, with or without a scheme. Not inside another token (an
 * e-mail address, user info or a longer host): the character before it must not be part of one.
 */
const CANDIDATE =
  /(?<![\w@.:/%-])((?:https?:\/\/)?[A-Za-z0-9.-]+(?::\d{1,5})?\/[jr]\/[^\s<>"'`“”‘’]+)/i;
/** Sentence punctuation that may follow a pasted link. */
const TRAILING = /[.,;:!?)\]}>]+$/;

/** A bare join code, rejoin code or short code (canonical form), else null. */
export function bareInviteCode(input: string): string | null {
  const text = input.trim();
  if (JOIN_CODE.test(text) || REJOIN_CODE.test(text)) return text;
  return normalizeShortCode(text);
}

/**
 * The first room or join link in pasted text as an absolute https URL string (trimmed, sentence
 * punctuation and one trailing slash removed, https:// added when missing), else null. The host
 * is not checked here.
 */
export function pastedLink(input: string): string | null {
  if (input.length > MAX_PASTE_LENGTH) return null;
  const found = CANDIDATE.exec(input.trim());
  if (!found) return null;
  let link = found[1]!.replace(TRAILING, '');
  // One trailing slash (…/j/CODE/), also before sentence punctuation (…/j/CODE/.).
  if (link.endsWith('/')) link = link.slice(0, -1).replace(TRAILING, '');
  return /^https?:\/\//i.test(link) ? link : `https://${link}`;
}

/** Whether host is the origin's host or its www. form. */
export function sameSite(url: URL, origin: string): boolean {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return false;
  }
  const host = url.host.toLowerCase();
  const own = base.host.toLowerCase();
  return host === own || host === `www.${own}`;
}

/**
 * The invitation code in pasted text for this origin: a /j/<code> link (anywhere in the text) or
 * a bare code. Returns the canonical code (43-character join code, rejoin code or 8-character
 * short code without dash), or null when nothing usable was pasted.
 */
export function inviteCodeFrom(input: string, origin: string): string | null {
  if (typeof input !== 'string' || input.length > MAX_PASTE_LENGTH) return null;
  const bare = bareInviteCode(input);
  if (bare) return bare;
  const link = pastedLink(input);
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash || !sameSite(url, origin)) return null;
  const path = /^\/j\/([A-Za-z0-9_.-]+)$/.exec(url.pathname);
  return path ? bareInviteCode(path[1]!) : null;
}

const ROOM_TOKEN = /^crr_[A-Za-z0-9_-]{43}$/;
/**
 * A room link (/r/<slug>#crr_...) of this origin in pasted text, or a bare room token: the token
 * and the slug (null for a bare token), else null. Same forgiving reading as inviteCodeFrom.
 */
export function roomTokenFrom(
  input: string,
  origin: string,
): { token: string; slug: string | null } | null {
  if (typeof input !== 'string' || input.length > MAX_PASTE_LENGTH) return null;
  const text = input.trim();
  if (ROOM_TOKEN.test(text)) return { token: text, slug: null };
  const link = pastedLink(text);
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || !sameSite(url, origin)) return null;
  const path = /^\/r\/([a-z0-9-]{3,64})$/.exec(url.pathname);
  const token = decodeURIComponent(url.hash.slice(1));
  return path && ROOM_TOKEN.test(token) ? { token, slug: path[1]! } : null;
}
