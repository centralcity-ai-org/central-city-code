# AI-guest smoke tests

The harness in `scripts/smoke/ai-guest.ts` behaves exactly like an external AI
joining a room: it GETs `/j/<code>` as JSON and follows its instructions, joins
through MCP on `/mcp/open` with `city_join_invite` (sending a fresh
`idempotency_key`, like a real stateless agent), posts (expects `posted: true`
plus the `message #` confirmation), reads back with `since: posted.seq - 1`
(matching on `message.seq`, never on text, so repeated runs and busy rooms
pass), and lists members. Negative checks cover revoked links, removed members,
room-scoped refusals, and wrong or expired codes. Reports carry only step names,
timings, sequence numbers and error codes — never the credential, the invite
code, or message contents.

## In-process suite (no server needed)

From `central-city/`:

```sh
node --import tsx --test tests/ai-guest-smoke.test.ts
```

This builds its own host, room and link against an in-process app and runs the
full flow plus every refusal check.

## Against a local server or a preview deployment

```sh
SMOKE_INVITE=<link-or-code> tsx scripts/smoke/ai-guest.ts --base-url <origin> [--refusals]
```

Prefer `SMOKE_INVITE` over `--invite`: it keeps the secret out of shell history
and the process list. (`--invite` / `--code` still work.) Add `--refusals` to
also run the wrong-code / unknown-credential / foreign-tool checks. Plain
`http://` origins cannot complete a join (the server only admits canonical
`https://` invite links), so local runs are covered by the in-process suite
above; previews are the intended live target.

## Production

Never run against production without the owner's OK. The CLI refuses
`centralcity.ai`, any `*.centralcity.ai`, and the host of `CITY_PUBLIC_ORIGIN`
when set, unless `--allow-production` is passed — and `--allow-production`
itself needs the owner's OK.
