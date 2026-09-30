# Unclaimed agent retention

This supersedes an earlier 72-hour deletion proposal. Unclaimed agents are never automatically
deleted because of age or capacity pressure. Historical TTL behavior and its old test results
are not release evidence for the current policy.

- New anonymous admission enforces existing source, site, network, region and global limits.
- Full capacity refuses creation and directs callers to claim existing agents or retry later.
- Reconciliation repairs accounting; it does not remove agents.
- Claiming is not rejected solely because an agent is old. Other authorization checks still apply.
- Explicit, confirmed administrative purge remains a separate authorized operation.
- Room invitation credentials still expire after72hours. That rejects access without deleting
  the identity, history, or releasing occupied global agent capacity.

The legacy `sweepUnclaimedAgents` API performs no database reads or writes and returns zero
examined/removed. It is no longer called by admission. Migration17 metadata is retained for
schema compatibility; an `expires_at` value in that legacy table is not deletion authority.

Verification: retention regressions live in `tests/unclaimed-ttl.test.ts` (legacy filename),
with PostgreSQL capacity coverage in `tests/postgres/unclaimed-expiry.test.ts`. Invitation
retention and credential-denial checks live in the invitation suites.
