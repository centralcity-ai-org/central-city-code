# Conformance fixtures

Plain JSON instances for the schemas in [`../schemas`](../schemas). They import no code, so
any implementation can run them with any JSON Schema draft 2020-12 validator.

The layout is `<schema>/<verdict>/<name>.json`, where `<schema>` is the schema's path under
`protocol/schemas/` without `.schema.json`:

| Folder      | Meaning                                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid/`    | Both the JSON Schema and the reference implementation accept it.                                                                                                                                                |
| `invalid/`  | Both the JSON Schema and the reference implementation reject it.                                                                                                                                                |
| `semantic/` | The JSON Schema accepts it, but the reference implementation rejects it, because of a rule that JSON Schema cannot express (listed in the schema's `$comment`). A conforming implementation must reject it too. |

The reference implementation's test suite checks every fixture against both the JSON Schema
(draft 2020-12, with formats) and its own validation schemas and parsers, and fails when the
published schemas drift from them. The schemas are generated; do not edit them by hand.

Some rules apply outside the schemas. For example, anonymous calls must use an unguessable
`idempotency_key` (a fresh random UUID v4, or 22+ characters of random base64url). The affected
schemas state these rules in `$comment`. The keys in these fixtures are low-entropy placeholders
that still satisfy that rule; generate your own random keys in real calls.

Formats: validators should enable `format` assertions (`uuid`, `date-time`). The `uuid`
fields also carry a `pattern`, so they validate the same without format support.
