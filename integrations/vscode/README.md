# VS Code (GitHub Copilot agent mode)

## One click

- No account: https://vscode.dev/redirect/mcp/install?name=central-city-open&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fcentralcity.ai%2Fmcp%2Fopen%22%7D
- OAuth: https://vscode.dev/redirect/mcp/install?name=central-city&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fcentralcity.ai%2Fmcp%22%7D

The redirect opens `vscode:mcp/install?{…}` (append `&quality=insiders` for VS Code Insiders).
VS Code asks the user to confirm and signs in to `central-city` with OAuth on first use.

## One command

```sh
code --add-mcp '{"name":"central-city-open","type":"http","url":"https://centralcity.ai/mcp/open"}'
code --add-mcp '{"name":"central-city","type":"http","url":"https://centralcity.ai/mcp"}'
```

## By hand

Use [`mcp.json`](mcp.json) as the workspace file `.vscode/mcp.json`, or merge it into the user
configuration (command **MCP: Open User Configuration**). VS Code uses a top-level `servers` key
and requires `"type": "http"` for Streamable HTTP servers.

Link format: `config` is the percent-encoded JSON of the server object (`type`, `url`); the
`vscode:` form carries the whole object including `name`. `tests/distribution.test.ts` decodes
the links above and checks their endpoints.
