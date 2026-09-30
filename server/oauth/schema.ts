/**
 * OAuth authority tables for the remote MCP front door. Like assistant grants, these are
 * authority rather than recovery data: offline backups exclude them and a restore starts
 * without them, so no restored database can silently regain remote access.
 *
 * The tables are created by migration 4 (server/migrations.ts).
 */
export const OAUTH_TABLES = [
  'oauth_clients',
  'oauth_codes',
  'oauth_families',
  'oauth_pending',
  'oauth_tokens',
] as const;
