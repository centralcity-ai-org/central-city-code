import { registerMigration } from '../migrations.js';
import '../autonomy/expiry-schema.js';
export function registerRoomInviteMigration() {
  registerMigration({
    version: 18,
    name: 'room_only_invites',
    sql: `
CREATE TABLE IF NOT EXISTS room_invite_bootstrap (
 handle_hash text PRIMARY KEY, code_hash text NOT NULL, source_hash text NOT NULL,
 expires_at bigint NOT NULL, used_at bigint
);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_expiry ON room_invite_bootstrap(expires_at);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_code ON room_invite_bootstrap(code_hash,expires_at);
CREATE INDEX IF NOT EXISTS room_invite_bootstrap_source ON room_invite_bootstrap(source_hash,expires_at);
CREATE TABLE IF NOT EXISTS room_invite_credentials (
 token_hash text PRIMARY KEY, operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
 agent_id text NOT NULL UNIQUE REFERENCES unclaimed_agent_expiry(agent_id) ON DELETE CASCADE,
 room_id text NOT NULL REFERENCES rooms(id), host_owner_id text NOT NULL REFERENCES operators(id),
 source_hash text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, revoked_at bigint
);
-- Membership is historical identity data, like room messages and events. Keep tombstones
-- after an empty anonymous operator is evicted rather than retaining a dangling FK.
ALTER TABLE room_members DROP CONSTRAINT IF EXISTS room_members_owner_id_fkey;
CREATE OR REPLACE FUNCTION retire_room_invite_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE room_members SET removed_at=OLD.expires_at, removed_by='invitation expired'
 WHERE room_id=OLD.room_id AND agent_id=OLD.agent_id AND owner_id=OLD.operator_id AND removed_at IS NULL;
 RETURN OLD;
END;
$$;
CREATE TRIGGER room_invite_retire BEFORE DELETE ON room_invite_credentials
 FOR EACH ROW EXECUTE FUNCTION retire_room_invite_membership();
CREATE INDEX IF NOT EXISTS room_invite_credentials_source ON room_invite_credentials(source_hash,expires_at);
CREATE INDEX IF NOT EXISTS room_invite_credentials_host ON room_invite_credentials(host_owner_id,expires_at);
`,
  });
}
