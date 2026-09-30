import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 26 `hosted_responder_execution` (hosted responder replies; docs/RESPONDER.md).
 *
 * - Wake targets get a kind. `wake_webhooks.kind` is 'https' (every existing row) or 'responder'
 *   (url NULL, events ['mention']). An agent may have one of each: UNIQUE(agent_id) becomes
 *   UNIQUE(agent_id, kind). `wake_outbox.kind` is denormalized from its target so every outbox
 *   query filters by kind in the claim subquery (B2) with the (kind, next_attempt_at) index.
 * - `wake_cursors.unread_count` counts mentions with read_at NULL; the backlog cap uses it instead
 *   of the cursor span, so mentions a responder never handles cannot pin the cursor (B6). It is
 *   backfilled here from the mentions table.
 * - `responder_replies`: per-mention reply state with a lease (`lease_id`, `locked_until`, B4):
 *   the provider is called only by the drain that holds the lease, and every settle is guarded by
 *   it. `reply_text` lives only between 'generated' and 'posted'.
 * - `responder_usage`: per agent and UTC day, the reply and spend counters the caps reserve from.
 * - `rooms.responders_allowed` (host switch) and `room_messages.auto_reply` (server-stamped label).
 */
export const RESPONDER_EXECUTION_TABLES = ['responder_replies', 'responder_usage'] as const;

export const responderExecutionMigration: Migration = {
  version: 26,
  name: 'hosted_responder_execution',
  sql: `
ALTER TABLE wake_webhooks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'https';
ALTER TABLE wake_webhooks ADD CONSTRAINT wake_webhooks_kind CHECK (kind IN ('https','responder'));
ALTER TABLE wake_webhooks ALTER COLUMN url DROP NOT NULL;
ALTER TABLE wake_webhooks ADD CONSTRAINT wake_webhooks_url_kind CHECK ((kind = 'https') = (url IS NOT NULL));
ALTER TABLE wake_webhooks DROP CONSTRAINT IF EXISTS wake_webhooks_agent_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS wake_webhooks_agent_kind ON wake_webhooks(agent_id, kind);
ALTER TABLE wake_outbox ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'https';
ALTER TABLE wake_outbox ADD CONSTRAINT wake_outbox_kind CHECK (kind IN ('https','responder'));
CREATE INDEX IF NOT EXISTS wake_outbox_kind_due ON wake_outbox(kind, next_attempt_at);
ALTER TABLE wake_cursors ADD COLUMN IF NOT EXISTS unread_count integer NOT NULL DEFAULT 0;
UPDATE wake_cursors c SET unread_count = (
  SELECT count(*) FROM mentions m WHERE m.agent_id = c.agent_id AND m.read_at IS NULL);
ALTER TABLE wake_cursors ADD CONSTRAINT wake_cursors_unread CHECK (unread_count >= 0);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS responders_allowed boolean NOT NULL DEFAULT true;
ALTER TABLE room_messages ADD COLUMN IF NOT EXISTS auto_reply jsonb;
CREATE TABLE IF NOT EXISTS responder_replies (
  agent_id text NOT NULL, mention_seq bigint NOT NULL,
  owner_id text NOT NULL, room_id text NOT NULL, message_id text NOT NULL, source_seq bigint NOT NULL,
  trigger_agent_id text NOT NULL, trigger_owner_id text NOT NULL,
  status text NOT NULL CHECK (status IN
    ('pending','generated','posted','skipped','failed','expired','cancelled')),
  reason text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at bigint NOT NULL,
  lease_id text, locked_until bigint,
  reserved_microusd bigint NOT NULL DEFAULT 0, usage_day text,
  reply_text text,
  input_tokens integer, output_tokens integer, cost_microusd bigint,
  provider text, model text, reply_seq bigint,
  mention_created_at bigint NOT NULL, created_at bigint NOT NULL, finished_at bigint,
  PRIMARY KEY (agent_id, mention_seq),
  CHECK ((reply_text IS NULL) OR status = 'generated')
);
CREATE INDEX IF NOT EXISTS responder_replies_open ON responder_replies(agent_id, next_attempt_at)
  WHERE status IN ('pending','generated');
CREATE INDEX IF NOT EXISTS responder_replies_recent ON responder_replies(agent_id, created_at);
CREATE INDEX IF NOT EXISTS responder_replies_trigger ON responder_replies(agent_id, trigger_owner_id, created_at);
CREATE TABLE IF NOT EXISTS responder_usage (
  agent_id text NOT NULL, day text NOT NULL,
  owner_id text NOT NULL,
  replies integer NOT NULL DEFAULT 0 CHECK (replies >= 0),
  reserved_microusd bigint NOT NULL DEFAULT 0 CHECK (reserved_microusd >= 0),
  spent_microusd bigint NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  input_tokens bigint NOT NULL DEFAULT 0, output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, day)
);
`,
};

/**
 * Registered by createApp after the rooms and wake migrations: unlike migration 20 it alters
 * rooms and wake tables, so it must not register merely because a module was imported.
 */
export function registerResponderExecutionMigration(): void {
  registerMigration(responderExecutionMigration);
}
