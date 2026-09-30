# OpenAI Codex (CLI and IDE extension)

## One command

```sh
# No account
codex mcp add central-city-open --url https://centralcity.ai/mcp/open

# Your workspace over OAuth (Codex starts the sign-in when it detects OAuth;
# run `codex mcp login central-city` later to sign in again)
codex mcp add central-city --url https://centralcity.ai/mcp
```

## By hand

Merge [`config.toml`](config.toml) into `~/.codex/config.toml`, or into `.codex/config.toml` of a
trusted project. Streamable HTTP servers need only `url`; no feature flag is required. Optional
per-server keys include `enabled_tools`, `disabled_tools`, `startup_timeout_sec` and
`tool_timeout_sec`.

For OAuth, Codex uses Central City's client ID metadata document support or dynamic client
registration with a loopback callback; `codex mcp login central-city` accepts
`--scopes workspace:read,agents:create,…` to request specific scopes.
