import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 41 `google_signin` (docs/GOOGLE_SIGNIN.md). Needs migration 39 (Elric), whose
 * `elric_verified_identities` holds the verified Google link (one Google subject per account,
 * unique index on provider and subject).
 *
 * - `elric_verified_identities.hd`: the Google Workspace domain of a linked account, or NULL for
 *   a gmail.com address. Only sub, email and hd are stored from Google; never a token.
 * - `elric_age_checks`: Elric's 18+ age confirmation per account (pii.ts): the date of birth,
 *   envelope-encrypted (`dob_*`, CITY_PII_KEK), the recomputed `over_18`, and `locked_at` once a
 *   date under 18 was given (the lock stays). Deleted with the account.
 * - `google_signin_flows`: one started sign-in or link, used at most once and only within 10
 *   minutes. The state is stored hashed; the browser that started it holds a binding cookie whose
 *   hash must match. The nonce and the PKCE verifier are random per flow; the row is deleted when
 *   the callback consumes it. `operator_id` is the account being linked (link flows only).
 * - `google_age_locks`: a Google account whose linked account was age-locked (under 18): a keyed
 *   hash of the subject and the time, never deleted, so the lock follows that Google account to
 *   any account it is linked to. Nothing else.
 * - `google_link_cooldowns`: after an unlink, a keyed hash of the Google subject, the account it
 *   was unlinked from and when (cooldown.ts), for the 30-day relink cooldown. Nothing else.
 */
export const GOOGLE_TABLES = [
  // Migration 48 (onboarding): the accepted Terms/Privacy version per account.
  'account_terms_acceptances',
  // Migration 49: every acceptance (append-only).
  'account_terms_acceptance_history',
  'elric_age_checks',
  'google_age_locks',
  'google_link_cooldowns',
  'google_signin_flows',
] as const;

export const GOOGLE_MIGRATION_SQL = `
ALTER TABLE elric_verified_identities ADD COLUMN IF NOT EXISTS hd text
  CHECK (hd IS NULL OR char_length(hd) BETWEEN 1 AND 253);
CREATE TABLE IF NOT EXISTS google_signin_flows (
  state_hash text PRIMARY KEY,
  binder_hash text NOT NULL,
  nonce text NOT NULL,
  verifier text NOT NULL,
  redirect_uri text NOT NULL,
  intent text NOT NULL CHECK (intent IN ('signin','link')),
  operator_id text REFERENCES operators(id) ON DELETE CASCADE,
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  CHECK ((intent = 'link') = (operator_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS google_signin_flows_expiry ON google_signin_flows(expires_at);
CREATE TABLE IF NOT EXISTS google_link_cooldowns (
  subject_hash text PRIMARY KEY CHECK (char_length(subject_hash) = 64),
  operator_id text NOT NULL,
  released_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS google_link_cooldowns_released ON google_link_cooldowns(released_at);
CREATE TABLE IF NOT EXISTS google_age_locks (
  subject_hash text PRIMARY KEY CHECK (char_length(subject_hash) = 64),
  locked_at bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS elric_age_checks (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  dob_ciphertext bytea,
  dob_wrapped_dek bytea,
  dob_kek_id text,
  source text CHECK (source IN ('owner','google')),
  over_18 boolean,
  checked_at bigint,
  locked_at bigint,
  refused_corrections integer NOT NULL DEFAULT 0,
  CHECK ((dob_ciphertext IS NULL) = (dob_wrapped_dek IS NULL)
     AND (dob_ciphertext IS NULL) = (dob_kek_id IS NULL))
);
`;

export const googleMigration: Migration = {
  version: 41,
  name: 'google_signin',
  sql: GOOGLE_MIGRATION_SQL,
};

/**
 * Migration 48: the Terms of Service and Privacy Policy version an account accepted, and when
 * (shared/terms.ts). An account created with Google stays in onboarding until it has a name and
 * an acceptance of the current version (server/app.ts onboarding gate).
 */
export const ONBOARDING_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS account_terms_acceptances (
  operator_id text PRIMARY KEY REFERENCES operators(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 32),
  accepted_at bigint NOT NULL
);
`;
export const onboardingMigration: Migration = {
  version: 48,
  name: 'account_terms_acceptances',
  sql: ONBOARDING_MIGRATION_SQL,
};

/**
 * Migration 49: every acceptance, appended and never updated (account_terms_acceptances keeps
 * only the latest, for the gate). Backfilled once from the latest acceptances.
 */
export const ACCEPTANCE_HISTORY_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS account_terms_acceptance_history (
  id bigserial PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 32),
  accepted_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS account_terms_acceptance_history_operator
  ON account_terms_acceptance_history(operator_id, accepted_at);
INSERT INTO account_terms_acceptance_history(operator_id,version,accepted_at)
  SELECT a.operator_id,a.version,a.accepted_at FROM account_terms_acceptances a
   WHERE NOT EXISTS (SELECT 1 FROM account_terms_acceptance_history h
                      WHERE h.operator_id=a.operator_id AND h.version=a.version
                        AND h.accepted_at=a.accepted_at);
`;
export const acceptanceHistoryMigration: Migration = {
  version: 49,
  name: 'account_terms_acceptance_history',
  sql: ACCEPTANCE_HISTORY_MIGRATION_SQL,
};

/**
 * Migration 50: the acceptance history is append-only in the database, like the Elric turn log:
 * UPDATE and TRUNCATE are refused, and DELETE only as part of deleting the account itself (the
 * ON DELETE CASCADE from operators, when the account row is already gone).
 */
export const ACCEPTANCE_HISTORY_APPEND_ONLY_SQL = `
CREATE OR REPLACE FUNCTION account_terms_acceptance_history_append_only() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM operators WHERE id = OLD.operator_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account_terms_acceptance_history is append-only';
END;
$$;
DROP TRIGGER IF EXISTS account_terms_acceptance_history_append_only
  ON account_terms_acceptance_history;
CREATE TRIGGER account_terms_acceptance_history_append_only
  BEFORE UPDATE OR DELETE ON account_terms_acceptance_history
  FOR EACH ROW EXECUTE FUNCTION account_terms_acceptance_history_append_only();
DROP TRIGGER IF EXISTS account_terms_acceptance_history_no_truncate
  ON account_terms_acceptance_history;
CREATE TRIGGER account_terms_acceptance_history_no_truncate
  BEFORE TRUNCATE ON account_terms_acceptance_history
  FOR EACH STATEMENT EXECUTE FUNCTION account_terms_acceptance_history_append_only();
`;
export const acceptanceHistoryAppendOnlyMigration: Migration = {
  version: 50,
  name: 'account_terms_acceptance_history_append_only',
  sql: ACCEPTANCE_HISTORY_APPEND_ONLY_SQL,
};

/** Idempotent; call before runMigrations (after the Elric migration). */
export function registerGoogleMigration(): void {
  registerMigration(googleMigration);
  registerMigration(onboardingMigration);
  registerMigration(acceptanceHistoryMigration);
  registerMigration(acceptanceHistoryAppendOnlyMigration);
}
