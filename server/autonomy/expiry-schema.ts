import { registerMigration, type Migration } from '../migrations.js';

// Legacy migration17 metadata is retained for compatibility; agents are never deleted because of their age.
// The duration remains the independent room-credential lifetime, not an agent retention policy.
export const UNCLAIMED_AGENT_TTL_MS = 72 * 60 * 60_000;
export const unclaimedExpiryMigration: Migration = {
  version: 17,
  name: 'unclaimed_agent_expiry',
  sql: `
CREATE TABLE IF NOT EXISTS unclaimed_agent_expiry (
  agent_id text PRIMARY KEY,
  operator_id text NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  expires_at bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS unclaimed_agent_expiry_due ON unclaimed_agent_expiry(expires_at,agent_id);
CREATE INDEX IF NOT EXISTS unclaimed_agent_expiry_owner ON unclaimed_agent_expiry(operator_id);
INSERT INTO unclaimed_agent_expiry(agent_id,operator_id,expires_at)
SELECT a.value->>'id',w.operator_id,
  (extract(epoch FROM (a.value->>'createdAt')::timestamptz)*1000)::bigint+259200000
FROM workspaces w JOIN operators o ON o.id=w.operator_id AND o.kind='unclaimed'
CROSS JOIN LATERAL jsonb_array_elements(w.data->'agents') a(value)
ON CONFLICT (agent_id) DO NOTHING;
`,
};
registerMigration(unclaimedExpiryMigration);
