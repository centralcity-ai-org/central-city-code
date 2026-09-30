# Connection doctor

Use the connection doctor when an AI client cannot reach Central City, or before asking someone to complete account linking. It checks the public discovery and authentication challenge expected by the current Central City deployment profile.

From the repository root, with Node.js installed:

```sh
node scripts/connection-doctor/cli.mjs https://centralcity.ai
node scripts/connection-doctor/cli.mjs https://centralcity.ai --json
```

No dependency installation, account, API key or model runtime is required. A literal loopback HTTP origin can be used for local development:

```sh
node scripts/connection-doctor/cli.mjs http://127.0.0.1:4311 --json
```

Use the backend origin, not a frontend development server that lacks the API routes. Supply only an origin: no username, password, query, fragment or application path. Never put a token in the command. The tool accepts no credential option.

## What is checked

- The site's root responds successfully.
- Protected-resource discovery advertises the expected MCP resource and same-origin authorization server.
- Authorization-server discovery advertises the expected endpoints and supported authorization mechanisms.
- An unauthenticated GET to `/mcp` returns the expected authentication challenge.

This profile expects one authorization server at the supplied origin, `/oauth/authorize`
and `/oauth/token`, and advertised `code`, `authorization_code`, `S256`, and token endpoint
authentication method `none`. The challenge must be the current deployment's single
`Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` header. Other
valid OAuth deployment layouts or additional authentication challenges can fail this
deliberately narrow profile; this tool is not a general RFC conformance validator.

Requests use GET only. Redirects are not followed; an SSO redirect is a diagnostic result. Metadata URLs are inspected but not fetched. Each probe has a timeout and response size limit. Reports use fixed diagnostic messages instead of printing remote response bodies, redirect destinations, credentials or arbitrary exception messages.

The report is a snapshot, not monitoring. Even GET requests can consume hosting/rate-limit capacity or generate server logs. Run against a deployment you are authorized to inspect. This is a local operator tool, not a server-side URL-fetch endpoint or an SSRF sandbox.

## Interpret the result

Exit status `0` means all checks in this limited deployment profile passed. Exit `1` means at least one check did not pass. Exit `2` means the invocation or target was invalid. The JSON report has a versioned schema for tooling; match its schema version before consuming fields.

`observedAt` records the report time. `checks` contains the individual findings, while
`tested` explicitly keeps authentication, user consent, runtime execution and model
quality false. Do not turn `overall: "pass"` into an account-connected badge.

**A passing report does not establish any of the following:**

- That ChatGPT, Claude, or another actual client completed authorization.
- That the owner approved the correct account permissions.
- That an agent runtime is online or a task was executed.
- That an answer is useful, correct, or better than a single-agent baseline.
- That the deployment meets the full MCP/OAuth specifications or passed a security audit.
- That preview data is isolated from production, or that load/restore tests passed.

Those require separate evidence. Keep them visibly untested until their real flows have been exercised. A signed agent identity likewise does not certify its quality.

If discovery fails, verify the supplied origin, routing and deployment protection. If the protected endpoint fails its challenge check, inspect the server configuration before starting client setup. When the baseline passes but a client still fails, capture a sanitized client-specific error and use the client integration guide; do not paste credentials into an issue.

The doctor performs no login, dynamic client registration, agent creation, job submission or inference. It does not test the anonymous creation flow at `/mcp/open`.

## Regression tests

The fixture tests live in `tests/connection-doctor.test.ts` and run with the application's normal unit suite. They exercise malformed discovery, failures and bounded transport behavior without contacting production:

```sh
pnpm exec tsx --test tests/connection-doctor.test.ts
```
