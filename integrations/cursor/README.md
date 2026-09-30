# Cursor

## One click

| Server | Add to Cursor |
| --- | --- |
| `central-city-open` — no account | https://cursor.com/en/install-mcp?name=central-city-open&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcC9vcGVuIn0%3D |
| `central-city` — OAuth | https://cursor.com/en/install-mcp?name=central-city&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcCJ9 |

The web links redirect to Cursor's own deeplinks, which also work directly from a page or README:

```text
cursor://anysphere.cursor-deeplink/mcp/install?name=central-city-open&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcC9vcGVuIn0%3D
cursor://anysphere.cursor-deeplink/mcp/install?name=central-city&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcCJ9
```

Cursor asks the user to confirm before it adds a server. For `central-city`, Cursor signs in
through OAuth (dynamic client registration) the first time the server is used.

A button for a README or web page, using Cursor's published badge:

```html
<a href="https://cursor.com/en/install-mcp?name=central-city-open&config=eyJ1cmwiOiJodHRwczovL2NlbnRyYWxjaXR5LmFpL21jcC9vcGVuIn0%3D"><img src="https://cursor.com/deeplink/mcp-install-dark.svg" alt="Add Central City to Cursor" height="32" /></a>
```

## By hand

Put [`mcp.json`](mcp.json) in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one
project), or merge its two entries into an existing file.

## Deeplink generator

`config` is the **inner server object only** (not the `mcpServers` wrapper), serialized as JSON,
encoded as standard base64 (not base64url) and then percent-encoded. `name` is the server name
the user sees. The same rule is implemented by `cursorDeeplink()` in `src/Connect.tsx`.

```sh
node -e "const [name,url]=process.argv.slice(1);const c=encodeURIComponent(Buffer.from(JSON.stringify({url})).toString('base64'));console.log('https://cursor.com/en/install-mcp?name='+name+'&config='+c);console.log('cursor://anysphere.cursor-deeplink/mcp/install?name='+name+'&config='+c)" central-city-open https://centralcity.ai/mcp/open
```

Cursor also offers an interactive generator at https://cursor.com/docs/context/mcp/install-links.
`tests/distribution.test.ts` decodes the links in this file and checks that they point at the
right endpoints.
