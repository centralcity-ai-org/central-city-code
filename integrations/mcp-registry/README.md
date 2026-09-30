# Official MCP Registry

`/server.json` (repository root) is the prepared entry for https://registry.modelcontextprotocol.io:

- name `ai.centralcity/central-city` (reverse-DNS namespace of `centralcity.ai`, granted by HTTP
  domain verification), version `0.6.0`;
- two Streamable HTTP remotes, `https://centralcity.ai/mcp/open` (no auth) and
  `https://centralcity.ai/mcp` (OAuth). The schema allows several remotes, and one entry is
  required anyway: the registry refuses a remote URL that another server name already uses, and
  its moderation policy treats the same server under several names as spam. The schema has no
  per-remote auth field (OAuth is discovered from the `401`), so
  `_meta["io.modelcontextprotocol.registry/publisher-provided"]` records which remote is which;
- `$schema` 2025-12-11, validated offline against [schema/server.schema.json](schema/README.md)
  by `tests/distribution.test.ts`, which also applies the registry's extra checks (name parts,
  version not `latest` or a range, https-only URLs, GitHub repository pattern, 4 KB `_meta`).

Nothing has been published. Publishing is an outward-facing owner action.

## Domain verification file (HTTP method)

The registry verifies `centralcity.ai` by fetching `https://centralcity.ai/.well-known/mcp-registry-auth`
(HTTPS GET, `Accept: text/plain`, 10 s timeout, **no redirects**, status 200, at most 4096 bytes)
and matching `v=MCPv1; k=<algorithm>; p=<base64 public key>`. HTTP verification grants
`ai.centralcity/*` only; DNS verification (a TXT record with the same value, `mcp-publisher login
dns`) would also cover subdomain namespaces but changes DNS.

[`mcp-registry-auth.template`](mcp-registry-auth.template) shows the format with a placeholder. It
is deliberately **not** in `public/`: serving a placeholder would publish a broken proof. The test
suite fails if `public/.well-known/mcp-registry-auth` ever exists without a well-formed 32-byte
Ed25519 key. `vercel.json` already serves that path as `text/plain` with `Cache-Control:
no-cache`, and unknown `/.well-known/` paths now return 404 instead of the app shell.

## Publish steps (owner)

Prerequisites: the v0.6.0 release is deployed (server `serverInfo.version` 0.6.0 to match
`server.json`), the repository is public, and `https://centralcity.ai/mcp/open` and `/mcp`
answer from the public internet. Install the publisher CLI: `brew install mcp-publisher`, or the
release binary from https://github.com/modelcontextprotocol/registry/releases (verify its checksum).

```sh
# 1. Create an Ed25519 key pair OUTSIDE the repository (OpenSSL 3.0 or later; Git Bash on Windows).
#    Store key.pem in the team password manager; never commit it.
openssl genpkey -algorithm Ed25519 -out ~/secure/centralcity-mcp-registry.pem

# 2. Write the public proof into the app and deploy it (a normal reviewed PR to main).
echo "v=MCPv1; k=ed25519; p=$(openssl pkey -in ~/secure/centralcity-mcp-registry.pem -pubout -outform DER | tail -c 32 | base64)" > public/.well-known/mcp-registry-auth
curl -sS https://centralcity.ai/.well-known/mcp-registry-auth   # after deployment: must print the line

# 3. Log in (the token lasts 5 minutes), validate, publish.
PRIVATE_KEY="$(openssl pkey -in ~/secure/centralcity-mcp-registry.pem -noout -text | grep -A3 'priv:' | tail -n +2 | tr -d ' :\n')"
mcp-publisher login http --domain centralcity.ai --private-key "$PRIVATE_KEY"
unset PRIVATE_KEY
mcp-publisher validate server.json
mcp-publisher publish server.json

# 4. Check the listing.
curl -sS "https://registry.modelcontextprotocol.io/v0.1/servers?search=ai.centralcity"
```

Keep the proof file deployed: every later `login http` re-checks it. Versions are immutable, so
each change to `server.json` needs a new `version`. Deprecate or hide an entry with
`mcp-publisher status --status deprecated|deleted ai.centralcity/central-city <version>`. The
registry's terms dedicate published metadata to the public domain (CC0 1.0).

Sources: https://modelcontextprotocol.io/registry/quickstart,
https://modelcontextprotocol.io/registry/authentication,
https://modelcontextprotocol.io/registry/remote-servers,
https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md,
https://modelcontextprotocol.io/registry/terms-of-service.
