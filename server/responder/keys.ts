import { createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The responder root key (KEK) that wraps every stored provider key's data key (docs/RESPONDER.md).
 * It follows `wakeKeys` (server/wake/webhooks.ts) in shape
 * (current first, a PREVIOUS key during a rotation, a public fingerprint as kid) but differs on
 * purpose:
 *
 * - no HKDF fallback from CITY_RATE_LIMIT_KEY in hosted mode: stored ciphertext cannot be re-minted,
 *   and that widely used secret must not also unlock third-party credentials. Hosted without a
 *   valid CITY_RESPONDER_KEK, the feature is unavailable;
 * - it must be distinct from every other secret;
 * - locally without it, a random per-process key is used (stored keys stop working on restart);
 * - the key actually used to wrap data keys is HKDF-SHA256(the decoded variable, info
 *   'central-city/responder-kek/v1'), so the configured secret itself never touches ciphertext
 *   and a future purpose gets its own subkey.
 */
export interface ResponderKey {
  kid: string;
  key: Buffer;
}
export type ResponderKeyring =
  | { available: true; current: ResponderKey; all: ResponderKey[]; ephemeral: boolean }
  | { available: false; reason: 'missing' | 'invalid' | 'not_distinct' };

/** Public, non-secret id of a root key (a different domain string from the wake kid). */
export function responderKeyId(key: Buffer): string {
  return `k_${createHash('sha256').update('central-city/responder-kid:').update(key).digest('hex').slice(0, 12)}`;
}

const OTHER_SECRETS = [
  'CITY_RATE_LIMIT_KEY',
  'CITY_WAKE_SECRET',
  'CITY_WAKE_SECRET_PREVIOUS',
  'CITY_SIGNING_KEY',
  'CITY_SIGNING_KEY_PREVIOUS',
  'DATABASE_URL',
] as const;

/** 32 bytes from standard or URL-safe base64, else null. */
function decode32(value: string): Buffer | null {
  const text = value.trim();
  if (!/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) return null;
  const bytes = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return bytes.length === 32 ? bytes : null;
}

/** Every byte form another secret could take, to compare the KEK against. */
function forms(value: string): Buffer[] {
  const out: Buffer[] = [Buffer.from(value, 'utf8'), Buffer.from(value.trim(), 'utf8')];
  const b64 = decode32(value);
  if (b64) out.push(b64);
  if (/^[0-9a-f]{64}$/i.test(value.trim())) out.push(Buffer.from(value.trim(), 'hex'));
  return out;
}

/** The key-encryption key: HKDF-SHA256 of the configured root, bound to this one purpose. */
export function deriveKek(root: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', root, Buffer.alloc(0), 'central-city/responder-kek/v1', 32),
  );
}

export function responderKeys(
  env: Record<string, string | undefined>,
  options: { hosted: boolean },
): ResponderKeyring {
  const raw = env.CITY_RESPONDER_KEK;
  if (!raw) {
    if (options.hosted) return { available: false, reason: 'missing' };
    const key = randomBytes(32);
    const current = { kid: responderKeyId(key), key };
    return { available: true, current, all: [current], ephemeral: true };
  }
  const current = decode32(raw);
  const previous = env.CITY_RESPONDER_KEK_PREVIOUS
    ? decode32(env.CITY_RESPONDER_KEK_PREVIOUS)
    : null;
  if (!current || (env.CITY_RESPONDER_KEK_PREVIOUS && !previous))
    return { available: false, reason: 'invalid' };
  for (const name of OTHER_SECRETS) {
    const other = env[name];
    if (!other) continue;
    for (const form of forms(other))
      if (
        form.equals(current) ||
        (previous && form.equals(previous)) ||
        form.equals(Buffer.from(raw))
      )
        return { available: false, reason: 'not_distinct' };
  }
  const keys = [current, ...(previous && !previous.equals(current) ? [previous] : [])].map(
    (root) => {
      const key = deriveKek(root);
      return { kid: responderKeyId(key), key };
    },
  );
  return { available: true, current: keys[0]!, all: keys, ephemeral: false };
}
