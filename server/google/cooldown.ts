import { createHmac, hkdfSync } from 'node:crypto';
import type { Transaction } from '../database.js';
import { defaultPiiKeyring } from './pii.js';

/**
 * The relink cooldown (docs/GOOGLE_SIGNIN.md). Elric allowances are per account, so a Google
 * account that is unlinked cannot be linked to a DIFFERENT Central City account for 30 days
 * (linking it back to the same account is fine). The record is only a keyed hash of the Google
 * subject, the account it was unlinked from and when: no email, no other Google data.
 *
 * The hash is an HMAC under a key derived (HKDF, its own label) from the server secret
 * CITY_RATE_LIMIT_KEY, required in hosted mode, so the known or guessable subject ids cannot be
 * matched against a copy of the table. Local development without a secret uses a fixed, public
 * key. Rows older than 30 days are deleted when the table is next read.
 */
export const RELINK_COOLDOWN_MS = 30 * 24 * 60 * 60_000;

const DEV_KEY = 'central-city-local-development-only-google-relink-key';
let cached: { root: string; key: Buffer } | null = null;
function cooldownKey(): Buffer {
  const root = process.env.CITY_RATE_LIMIT_KEY || DEV_KEY;
  if (cached?.root !== root)
    cached = {
      root,
      key: Buffer.from(hkdfSync('sha256', root, '', 'central-city/google-relink-cooldown/v1', 32)),
    };
  return cached.key;
}

/** A Google account age-locked for Elric (never expires): only this keyed hash and the time. */
export async function lockSubject(
  tx: Pick<Transaction, 'query'>,
  subject: string,
  time: number,
): Promise<void> {
  const hash = ageLockHash(subject);
  // Without the PII key the account lock still applies; only this record is skipped.
  if (!hash) return;
  await tx.query(
    'INSERT INTO google_age_locks(subject_hash,locked_at) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [hash, time],
  );
}
export async function subjectLocked(
  q: Pick<Transaction, 'query'>,
  subject: string,
): Promise<boolean> {
  const hash = ageLockHash(subject);
  if (!hash) return false;
  return (
    (await q.query('SELECT 1 FROM google_age_locks WHERE subject_hash=$1', [hash])).rows.length > 0
  );
}
/**
 * The permanent age-lock hash: an HMAC under a key derived (HKDF, its own label) from the current
 * CITY_PII_KEK, never from CITY_RATE_LIMIT_KEY (rotating that must not drop locks). Rotating
 * CITY_PII_KEK changes this key and the subjects are not stored, so the locks cannot be re-hashed
 * (docs/GOOGLE_SIGNIN.md). Null without a key.
 */
function ageLockHash(subject: string): string | null {
  const keyring = defaultPiiKeyring();
  if (!keyring.available) return null;
  const key = Buffer.from(
    hkdfSync('sha256', keyring.current.key, '', 'central-city/google-age-lock/v1', 32),
  );
  return createHmac('sha256', key).update(`google\n${subject}`).digest('hex');
}

export const subjectHash = (subject: string) =>
  createHmac('sha256', cooldownKey()).update(`google\n${subject}`).digest('hex');

/** Starts the cooldown for `subject`, released by `operatorId` at `time`. */
export async function startCooldown(
  tx: Pick<Transaction, 'query'>,
  subject: string,
  operatorId: string,
  time: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO google_link_cooldowns(subject_hash,operator_id,released_at) VALUES($1,$2,$3)
     ON CONFLICT (subject_hash) DO UPDATE SET operator_id=EXCLUDED.operator_id, released_at=EXCLUDED.released_at`,
    [subjectHash(subject), operatorId, time],
  );
}

/** Read-only: true when `subject` was released by another account within 30 days. */
export async function cooldownBlocks(
  q: Pick<Transaction, 'query'>,
  subject: string,
  operatorId: string,
  time: number,
): Promise<boolean> {
  const row = (
    await q.query<{ operator_id: string }>(
      'SELECT operator_id FROM google_link_cooldowns WHERE subject_hash=$1 AND released_at>$2',
      [subjectHash(subject), time - RELINK_COOLDOWN_MS],
    )
  ).rows[0];
  return Boolean(row && row.operator_id !== operatorId);
}

/**
 * True when `subject` was released by another account within 30 days. A cooldown released by
 * `operatorId` itself is cleared (it is linking back).
 */
export async function inCooldown(
  tx: Pick<Transaction, 'query'>,
  subject: string,
  operatorId: string,
  time: number,
): Promise<boolean> {
  await tx.query('DELETE FROM google_link_cooldowns WHERE released_at<=$1', [
    time - RELINK_COOLDOWN_MS,
  ]);
  const hash = subjectHash(subject);
  const row = (
    await tx.query<{ operator_id: string }>(
      'SELECT operator_id FROM google_link_cooldowns WHERE subject_hash=$1',
      [hash],
    )
  ).rows[0];
  if (!row) return false;
  if (row.operator_id !== operatorId) return true;
  await tx.query('DELETE FROM google_link_cooldowns WHERE subject_hash=$1', [hash]);
  return false;
}
