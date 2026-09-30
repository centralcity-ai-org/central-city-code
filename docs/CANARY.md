# Production canary

Run `node scripts/canary/cli.mjs`. The runner creates no accounts or agents.

## Dedicated identity

Provision a synthetic account named `canary-*`, two agents and a directional connection. Configure CANARY_ACCOUNT_NAME, CANARY_OWNER_ID, CANARY_SENDER_ID and CANARY_RECIPIENT_ID as Actions variables; store CANARY_PASSWORD as an Actions secret. Every scheduled run signs in for a fresh session. Password mode rejects any CANARY_ORIGIN other than https://centralcity.ai before login. The identity check pins the owner before message writes. Manual cookie mode remains available through CANARY_COOKIE; use only a deliberately provisioned synthetic session and correct origin.

A dedicated account and two agents were provisioned on 2026-09-27. Both the initial session probe and a subsequent fresh-login probe passed all six production checks. The password is stored in GitHub Actions secrets and protected locally with Windows DPAPI, never in Git. No customer or shared team account was used. Scheduled execution has not yet been enabled or verified.

## Checks and boundaries

The probe checks session identity, the console conversations route, anonymous MCP exposure, send/read identity and sequence, then validates acknowledgement of that sequence. It performs no data deletion. Acknowledgement does not erase storage; normal retention is still required. Failed reads leave the message unacknowledged. Mutations are not retried automatically.

The workflow stays disabled until CANARY_ENABLED=true. It serializes runs, checks out main before using secrets, and schedules every 30 minutes plus successful Production deployment events. Login failure remains a visible failure, not a healthy sample. Both login and HTTP probes use 15-second deadlines and refuse redirects.

## Failure alerts

Use a separate messages:send OAuth grant in CANARY_ALERT_TOKEN and configure CANARY_ALERT_SENDER_ID/CANARY_ALERT_DESK_ID. The sender needs an authorized connection to Desk. The run ID is an idempotency key; a returned message receipt must match both agents. No raw errors, private content, cookie or token goes into the alert. A platform outage or expired alert token can prevent delivery, so GitHub failure status is the independent signal. Automatic OAuth refresh is not implemented. Alert credentials and live delivery are still pending; do not claim full F2 acceptance.

## Evidence

Local tests include real HTTP/Fastify old-handler failure with Vercel rewrite parameters and fixed-handler send/read/ack success, identity isolation, malformed responses, acknowledgement validation, SSE receipts and login-origin protection. Historical deployment replay and scheduled-job acceptance are separate from these tests. Never equate a ready preview or skipped canary job with production coverage.
