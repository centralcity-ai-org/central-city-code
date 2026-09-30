import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 20 `hosted_responder` (docs/RESPONDER.md).
 *
 * - `responder_settings`: the owner's auto-reply configuration, one row per agent. Only the owner,
 *   signed in to the console, writes it (no MCP tool, grant or workspace key can).
 * - `responder_credentials`: the owner's own OpenAI or Anthropic API key, envelope-encrypted
 *   (AES-256-GCM under a per-key data key, which is wrapped under CITY_RESPONDER_KEK; the AAD binds
 *   both layers to the row). Write-only: no API ever returns it or any part of it. Revoking nulls
 *   the secret columns. At most one non-revoked key per agent.
 *
 * The execution tables (per-mention reply state, daily usage) and the room columns come in their
 * own migration (26), because their shape depends on the wake outbox.
 */
export const RESPONDER_TABLES = ['responder_credentials', 'responder_settings'] as const;

export const responderMigration: Migration = {
  version: 20,
  name: 'hosted_responder',
  sql: `
CREATE TABLE IF NOT EXISTS responder_settings (
  agent_id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic')),
  model text NOT NULL CHECK (char_length(model) <= 100),
  instructions text NOT NULL DEFAULT '' CHECK (char_length(instructions) <= 2000),
  daily_reply_cap integer NOT NULL DEFAULT 100 CHECK (daily_reply_cap BETWEEN 1 AND 1000),
  daily_spend_cap_microusd bigint NOT NULL DEFAULT 2000000
    CHECK (daily_spend_cap_microusd BETWEEN 10000 AND 50000000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
  pause_reason text CHECK (pause_reason IN
    ('invalid_key','quota','rate_limited','model_unavailable','forbidden','key_removed','repeated_failures')),
  paused_until bigint,
  consecutive_failures integer NOT NULL DEFAULT 0,
  enabled_at bigint,
  created_at bigint NOT NULL, updated_at bigint NOT NULL, updated_by text NOT NULL
);
CREATE INDEX IF NOT EXISTS responder_settings_owner ON responder_settings(owner_id);
CREATE TABLE IF NOT EXISTS responder_credentials (
  id text PRIMARY KEY,
  agent_id text NOT NULL,
  owner_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('openai','anthropic')),
  kek_id text,
  wrapped_dek bytea,
  ciphertext bytea,
  status text NOT NULL CHECK (status IN ('active','invalid','revoked')),
  created_at bigint NOT NULL, created_by text NOT NULL,
  validated_at bigint, revoked_at bigint, revoked_by text,
  CHECK ((status = 'revoked') = (ciphertext IS NULL AND wrapped_dek IS NULL AND kek_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS responder_credentials_live
  ON responder_credentials(agent_id) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS responder_credentials_kek
  ON responder_credentials(kek_id) WHERE kek_id IS NOT NULL;
`,
};

/** Idempotent; call before runMigrations. */
export function registerResponderMigration(): void {
  registerMigration(responderMigration);
}
// Registered on import (like server/autonomy/expiry-schema.ts): the claim flows import the
// revocation helper, so the tables exist wherever those flows run.
registerResponderMigration();
