# Gemini CLI

## One command

```sh
gemini mcp add --transport http central-city-open https://centralcity.ai/mcp/open
gemini mcp add --transport http central-city https://centralcity.ai/mcp   # OAuth; /mcp auth central-city
```

`gemini mcp add` writes to the project's `.gemini/settings.json`; add `-s user` for
`~/.gemini/settings.json`.

## Extension (servers + context)

[`central-city/`](central-city) is a Gemini CLI extension: `gemini-extension.json` declares both
servers with `httpUrl` (Streamable HTTP; accepted by current and older Gemini CLI versions) and
`GEMINI.md` supplies the usage context.

```sh
gemini extensions install ./integrations/gemini-cli/central-city   # from a local clone
gemini extensions link ./integrations/gemini-cli/central-city      # development: live link
```

`gemini extensions install <github-url>` expects `gemini-extension.json` at the root of a
repository (or of a release archive); it has no subdirectory option. To distribute from GitHub
and to appear in the gallery at https://geminicli.com/extensions, publish this folder as the root
of its own public repository with the topic `gemini-cli-extension`; see
[docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md#gemini-cli-extension).

For `central-city`, Gemini CLI discovers OAuth from the `401` response (RFC 9728 metadata) and
registers itself dynamically; `/mcp auth central-city` repeats the sign-in.
