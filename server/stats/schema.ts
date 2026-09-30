import { registerMigration, type Migration } from '../migrations.js';

/**
 * Migration 28 `public_stats`: one row per public statistic, shared by every instance, so the homepage count runs about once per refresh interval
 * globally instead of once per instance.
 *
 * - `value`: the last computed number; `refreshed_at`: when it was computed (epoch ms).
 * - `refreshing_until`: the refresh lease. An instance claims it with one conditional UPDATE and
 *   only the winner counts, outside any transaction; a crashed winner's lease simply expires.
 *
 * Derived data: recomputed from workspaces at any time, never exported or restored.
 */
export const publicStatsMigration: Migration = {
  version: 28,
  name: 'public_stats',
  sql: `
CREATE TABLE IF NOT EXISTS public_stats (
  key text PRIMARY KEY CHECK (key ~ '^[a-z_]{1,64}$'),
  value bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  refreshed_at bigint NOT NULL DEFAULT 0,
  refreshing_until bigint NOT NULL DEFAULT 0
);
`,
};

registerMigration(publicStatsMigration);
