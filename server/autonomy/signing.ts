import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  exportJwks,
  generateSigningKey,
  jwkThumbprint,
  type Jwks,
  type SigningKey,
} from '../manifest/keys.js';

/**
 * Platform Agent Card signing key (Ed25519). Loaded from `CITY_SIGNING_KEY` as either a private
 * Ed25519 JWK (JSON, optionally `{kid, jwk}`) or base64 PKCS#8 DER. Without it, development and
 * tests use an ephemeral key (with a warning); hosted mode serves cards unsigned and says so.
 */
export interface PlatformSigner {
  key: SigningKey | null;
  /** Retired key from CITY_SIGNING_KEY_PREVIOUS, published in the JWKS for verification only. */
  previous: SigningKey | null;
  /** True when the key was generated for this process only (cards stop verifying on restart). */
  ephemeral: boolean;
  jwks(): Jwks;
}

function fromJwk(value: Record<string, unknown>): SigningKey {
  const jwk = (value.jwk && typeof value.jwk === 'object' ? value.jwk : value) as Record<
    string,
    unknown
  >;
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.d !== 'string')
    throw new Error('CITY_SIGNING_KEY must be a private Ed25519 JWK or PKCS#8 key.');
  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', d: jwk.d, x: String(jwk.x ?? '') },
    format: 'jwk',
  });
  return withKid(privateKey, typeof value.kid === 'string' ? value.kid : jwk.kid);
}

function withKid(privateKey: ReturnType<typeof createPrivateKey>, kid: unknown): SigningKey {
  if (privateKey.asymmetricKeyType !== 'ed25519')
    throw new Error('CITY_SIGNING_KEY must be an Ed25519 key.');
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: 'jwk' }).x!;
  return {
    kid: typeof kid === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(kid) ? kid : jwkThumbprint(x),
    privateKey,
    publicKey,
  };
}

export function parseSigningKey(raw: string): SigningKey {
  const text = raw.trim();
  try {
    if (text.startsWith('{')) return fromJwk(JSON.parse(text) as Record<string, unknown>);
    if (!/^[A-Za-z0-9+/=_-]+$/.test(text)) throw new Error('not base64');
    return withKid(
      createPrivateKey({ key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' }),
      undefined,
    );
  } catch {
    // Never echo key material in errors.
    throw new Error('CITY_SIGNING_KEY is not a valid Ed25519 private JWK or base64 PKCS#8 key.');
  }
}

const warned = new Set<string>();
/** Emits each distinct warning once per process. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  process.emitWarning(message);
}

export function loadPlatformSigner(
  env: NodeJS.ProcessEnv,
  hosted: boolean,
  warn: (message: string) => void = warnOnce,
  injected?: SigningKey | null,
): PlatformSigner {
  let key: SigningKey | null = null;
  let ephemeral = false;
  if (injected !== undefined) key = injected;
  else if (env.CITY_SIGNING_KEY) key = parseSigningKey(env.CITY_SIGNING_KEY);
  else if (!hosted) {
    key = generateSigningKey();
    ephemeral = true;
    warn(
      'CITY_SIGNING_KEY is not set; Agent Cards are signed with an ephemeral development key that changes on restart.',
    );
  } else warn('CITY_SIGNING_KEY is not set; hosted Agent Cards are served unsigned (flagged).');
  // Rotation: the previous key (verification only) stays in the JWKS until cards it signed
  // have expired from caches. It never signs.
  let previous: SigningKey | null = null;
  if (env.CITY_SIGNING_KEY_PREVIOUS) {
    try {
      previous = parseSigningKey(env.CITY_SIGNING_KEY_PREVIOUS);
    } catch {
      throw new Error(
        'CITY_SIGNING_KEY_PREVIOUS is not a valid Ed25519 private JWK or base64 PKCS#8 key.',
      );
    }
    if (previous.kid === key?.kid) previous = null;
  }
  const published = [key, previous].filter((item): item is SigningKey => item !== null);
  return { key, previous, ephemeral, jwks: () => exportJwks(published) };
}
