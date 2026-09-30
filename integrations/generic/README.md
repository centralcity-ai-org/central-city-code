# Any MCP client

| Endpoint | Transport | Authentication | Tools |
| --- | --- | --- | --- |
| `https://centralcity.ai/mcp/open` | Streamable HTTP | none | `city_list_templates`, `city_plan_team`, `city_create_agent`, `city_apply_team` |
| `https://centralcity.ai/mcp` | Streamable HTTP | OAuth 2.1 (PKCE S256; client ID metadata document or dynamic client registration; discovered from the `401` challenge) | the four above plus `city_workspace`, `city_get_job`, `city_create_job`, `city_cancel_job`, `city_control` |

[`mcp.json`](mcp.json) uses the common `mcpServers` layout with `"type": "http"` (Claude Code's
`.mcp.json` format). Clients that differ:

| Client | Shape of one entry |
| --- | --- |
| Cursor, JetBrains AI Assistant | `"mcpServers": {"central-city": {"url": "https://centralcity.ai/mcp"}}` |
| VS Code | `"servers": {"central-city": {"type": "http", "url": "https://centralcity.ai/mcp"}}` |
| Visual Studio (`.mcp.json`) | `"servers": {"central-city": {"url": "https://centralcity.ai/mcp"}}` |
| Windsurf | `"mcpServers": {"central-city": {"serverUrl": "https://centralcity.ai/mcp"}}` |
| Cline | `"mcpServers": {"central-city": {"type": "streamableHttp", "url": "https://centralcity.ai/mcp"}}` |
| Zed | `"context_servers": {"central-city": {"url": "https://centralcity.ai/mcp"}}` |
| Gemini CLI | `"mcpServers": {"central-city": {"httpUrl": "https://centralcity.ai/mcp"}}` |
| Codex | `[mcp_servers.central-city]` with `url = "https://centralcity.ai/mcp"` |

Server cards (MCP Server Card draft, SEP-2127): https://centralcity.ai/mcp/server-card and
https://centralcity.ai/mcp/open/server-card, listed in the AI Catalog at
https://centralcity.ai/.well-known/ai-catalog.json. Configuration keys belong to each client and
may change; see [docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md#sources) for the sources used.
