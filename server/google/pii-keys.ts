import { createHash, hkdfSync, randomBytes } from 'node:crypto';

/**
 * The root key (KEK) for personal data stored by Sign in with Google: today only the date of
 * birth (docs/GOOGLE_SIGNIN.md "Date of birth"). Same shape as the responder's key ring, but its
 * own secret and derivation:
 *
 * - CITY_PII_KEK (32 bytes, base64 or base64url), CITY_PII_KEK_PREVIOUS during a rotation;
 * - the key that wraps data keys is HKDF-SHA256(the decoded secret, info 'central-city/pii-kek/v1');
 * - it must differ from every other secret, in every form;
 * - hosted without a valid key the feature is unavailable (the age stays unknown: fail closed);
 *   locally without it, a random per-process key is used (stored dates stop opening on restart);
 * - never derived from CITY_RATE_LIMIT_KEY, and never the responder's key.
 */
export interface PiiKey {
  kid: string;
  key: Buffer;
}
export type PiiKeyring =
  | { available: true; current: PiiKey; all: PiiKey[]; ephemeral: boolean }
  | { available: false; reason: 'missing' | 'invalid' | 'not_distinct' };

/** Public, non-secret id of a derived key. */
export function piiKeyId(key: Buffer): string {
  return `p_${createHash('sha256').update('central-city/pii-kid:').update(key).digest('hex').slice(0, 12)}`;
}

export const PII_OTHER_SECRETS = [
  'CITY_RATE_LIMIT_KEY',
  'CITY_WAKE_SECRET',
  'CITY_WAKE_SECRET_PREVIOUS',
  'CITY_SIGNING_KEY',
  'CITY_SIGNING_KEY_PREVIOUS',
  'CITY_RESPONDER_KEK',
  'CITY_RESPONDER_KEK_PREVIOUS',
  'DATABASE_URL',
  'CRON_SECRET',
  'GOOGLE_OAUTH_CLIENT_SECRET',
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

export function derivePiiKek(root: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', root, Buffer.alloc(0), 'central-city/pii-kek/v1', 32));
}

let ephemeral: PiiKey | null = null;

export function piiKeys(
  env: Record<string, string | undefined>,
  options: { hosted: boolean },
): PiiKeyring {
  const raw = env.CITY_PII_KEK;
  if (!raw) {
    if (options.hosted) return { available: false, reason: 'missing' };
    if (!ephemeral) {
      const key = derivePiiKek(randomBytes(32));
      ephemeral = { kid: piiKeyId(key), key };
    }
    return { available: true, current: ephemeral, all: [ephemeral], ephemeral: true };
  }
  const current = decode32(raw);
  const previous = env.CITY_PII_KEK_PREVIOUS ? decode32(env.CITY_PII_KEK_PREVIOUS) : null;
  if (!current || (env.CITY_PII_KEK_PREVIOUS && !previous))
    return { available: false, reason: 'invalid' };
  const mine = [current, ...(previous ? [previous] : [])];
  for (const name of PII_OTHER_SECRETS) {
    const other = env[name];
    if (!other) continue;
    for (const form of forms(other))
      if (mine.some((key) => form.equals(key)) || form.equals(Buffer.from(raw)))
        return { available: false, reason: 'not_distinct' };
  }
  const keys = [current, ...(previous && !previous.equals(current) ? [previous] : [])].map(
    (root) => {
      const key = derivePiiKek(root);
      return { kid: piiKeyId(key), key };
    },
  );
  return { available: true, current: keys[0]!, all: keys, ephemeral: false };
}
