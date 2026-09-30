# Vendored JSON Schemas

`tests/distribution.test.ts` validates `server.json` and the MCP server card against these files.
Tests never fetch schemas from the network, so the copies are kept byte-for-byte as retrieved.
Refresh them deliberately (fetch, compare, update the table and re-run `pnpm test`).

| File | Source | Retrieved | SHA-256 | License |
| --- | --- | --- | --- | --- |
| `server.schema.json` | https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json (current `$schema` of the official MCP Registry, registry v1.8.1) | 2026-09-26 | `3fba09590c99f61735d234822279f4223fab9e300c0a81e81c91ab62a4114de0` | MIT. The file is generated from `docs/reference/api/openapi.yaml` of [modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry) (which declares `license: MIT`) and served from the MIT-licensed [modelcontextprotocol/static](https://github.com/modelcontextprotocol/static) repository. The registry repository is moving new contributions to Apache-2.0 (documentation CC-BY-4.0); see its `LICENSE`. |
| `server-card.schema.json` | https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.json (experimental extension tracking SEP-2127; not yet published at its future URL https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json, which returned 404 on the retrieval date) | 2026-09-26 | `2c772b51edb367f154771d84ddbae87ddba00a624422c8e46f218a9ac03bf042` | Apache-2.0 ([ext-server-card `LICENSE`](https://github.com/modelcontextprotocol/ext-server-card/blob/main/LICENSE)). |

Copyright in the schemas remains with their authors; they are included unmodified for
validation only. Metadata published to the MCP Registry is dedicated to the public domain under
CC0 1.0 by the registry's terms of service (section 10,
https://modelcontextprotocol.io/registry/terms-of-service).

`server.schema.json` declares JSON Schema draft-07; `server-card.schema.json` declares 2020-12.
The test uses the Ajv-based validator exported by `@modelcontextprotocol/server/validators/ajv`
(an existing dependency), which selects the engine from the `$schema` dialect.
