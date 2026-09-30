import { createHash, createHmac, hkdfSync, randomInt } from 'node:crypto';

/**
 * Short, speakable join codes (with guardrails against confusable characters): 8 characters
 * from Crockford's base32 alphabet (no I, L, O or U), about 40 bits, shown as `7K4M-Q9XP`. A code
 * is an alias of one join link: same room, same expiry (at most 24 hours) and same use limit. Only
 * its SHA-256 is stored (join_links.short_hash); the code itself is never stored or logged.
 */
export const SHORT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const SHORT_LENGTH = 8;

export function newShortCode(): string {
  let code = '';
  for (let i = 0; i < SHORT_LENGTH; i++) code += SHORT_ALPHABET[randomInt(SHORT_ALPHABET.length)];
  return code;
}
/** "7K4MQ9XP" -> "7K4M-Q9XP". */
export const formatShortCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * The canonical short code for what a person typed or pasted, or null. Tolerant: whitespace and
 * dashes are dropped, case is ignored, and the look-alikes Crockford defines are mapped
 * (O -> 0, I and L -> 1). Anything else is not a short code.
 */
export function normalizeShortCode(input: string): string | null {
  const cleaned = input
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (cleaned.length !== SHORT_LENGTH) return null;
  for (const char of cleaned) if (!SHORT_ALPHABET.includes(char)) return null;
  return cleaned;
}

/**
 * The stored hash of a short code: an HMAC under a key derived from the server secret
 * (CITY_RATE_LIMIT_KEY; required in hosted mode), so a database copy alone cannot recover live
 * codes by trying all 2^40. Local development without a secret uses a fixed, public key.
 */
const DEV_KEY = 'central-city-local-development-only-short-code-key';
let cached: { root: string; key: Buffer } | null = null;
function shortCodeKey(): Buffer {
  const root = process.env.CITY_RATE_LIMIT_KEY || DEV_KEY;
  if (cached?.root !== root)
    cached = {
      root,
      key: Buffer.from(hkdfSync('sha256', root, '', 'central-city/join-short-code/v1', 32)),
    };
  return cached.key;
}
export const shortCodeHash = (code: string) =>
  createHmac('sha256', shortCodeKey()).update(code).digest('hex');
/**
 * The unkeyed hash #131 stored. Codes live at most 24 hours, so lookups also accept it until
 * the last of those links has expired; remove after 2026-10-01.
 */
export const legacyShortCodeHash = (code: string) =>
  createHash('sha256').update(`join-short:${code}`).digest('hex');

/** Wrong or right, every short-code attempt counts (sign-in or address keyed by the caller). */
export const SHORT_CODE_LIMITS = {
  attemptsPerAccountPerHour: 30,
  attemptsPerAddressPerHour: 100,
  /**
   * Across all callers: bounds a distributed guess (many addresses) far below what 40 bits need,
   * while normal use stays far below it. Over it, short codes pause for everyone for the rest of
   * the hour; the full invite link keeps working.
   */
  attemptsGlobalPerHour: 20_000,
} as const;
