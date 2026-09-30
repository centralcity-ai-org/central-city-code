import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 11 `ai_workspaces` (docs/AI_WORKSPACES.md). An AI-owned workspace is an operator row
 * with `kind = 'ai'` (no password: the hash matches nothing and password login filters on
 * kind = 'owner'), its own workspace row and at least one workspace key. Keys, claim tokens and
 * creation receipts are stored hashed. Humans become co-owners through `operator_links`; the AI
 * operator keeps owning the workspace, so every query stays scoped by one operator id.
 * `ai_workspace_stats` holds LIVE capacity counters (existing AI workspaces, global and per address
 * scope by HMAC key), incremented in the creating transaction and decremented when an empty idle
 * workspace is reclaimed. The first key is `is_primary`: only itself or a co-owner may revoke it.
 */
export const aiWorkspacesMigration: Migration = {
  version: 11,
  name: 'ai_workspaces',
  sql: `
ALTER TABLE operators DROP CONSTRAINT IF EXISTS operators_kind_check;
ALTER TABLE operators ADD CONSTRAINT operators_kind_check CHECK (kind IN ('owner','unclaimed','ai'));
CREATE TABLE IF NOT EXISTS ai_workspaces (
  operator_id text PRIMARY KEY REFERENCES operators(id), slug text NOT NULL UNIQUE,
  claim_token_hash text UNIQUE, source_key text NOT NULL, site_key text NOT NULL,
  network_key text NOT NULL, region_key text NOT NULL, created_at bigint NOT NULL,
  claimed_at bigint
);
CREATE INDEX IF NOT EXISTS ai_workspaces_created ON ai_workspaces(created_at);
CREATE TABLE IF NOT EXISTS workspace_keys (
  id text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id),
  key_hash text NOT NULL UNIQUE, label text NOT NULL, scopes jsonb NOT NULL,
  created_at bigint NOT NULL, last_used_at bigint, revoked_at bigint,
  is_primary boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS workspace_keys_owner ON workspace_keys(operator_id);
CREATE TABLE IF NOT EXISTS workspace_key_receipts (
  key_id text NOT NULL REFERENCES workspace_keys(id) ON DELETE CASCADE,
  tool text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, resource_id text NOT NULL,
  PRIMARY KEY(key_id, tool, request_key)
);
CREATE TABLE IF NOT EXISTS ai_workspace_receipts (
  source_key text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL,
  operator_id text NOT NULL REFERENCES operators(id), created_at bigint NOT NULL,
  PRIMARY KEY(source_key, request_key)
);
CREATE TABLE IF NOT EXISTS ai_workspace_stats (
  scope_key text PRIMARY KEY, workspaces integer NOT NULL DEFAULT 0 CHECK (workspaces >= 0)
);
CREATE TABLE IF NOT EXISTS operator_links (
  human_operator_id text NOT NULL REFERENCES operators(id),
  ai_operator_id text NOT NULL REFERENCES operators(id),
  role text NOT NULL CHECK (role IN ('co-owner')), created_at bigint NOT NULL,
  PRIMARY KEY(human_operator_id, ai_operator_id)
);
CREATE INDEX IF NOT EXISTS operator_links_ai ON operator_links(ai_operator_id);
`,
};

/** Idempotent; call before runMigrations. */
export function registerAiWorkspacesMigration(): void {
  registerMigration(aiWorkspacesMigration);
}
