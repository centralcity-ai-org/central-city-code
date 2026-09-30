# Bundle budget

`scripts/bundle-budget/check.mjs` checks the JavaScript a visitor downloads on first load against the design-system budgets:

| Check                                        | Budget (gzip) |
| -------------------------------------------- | ------------- |
| `vendor` chunk (react, react-dom, scheduler) | ≤ 70 KB       |
| Route `/`, first-load JS                     | ≤ 90 KB       |
| Route `/rooms/:id`, first-load JS            | ≤ 125 KB      |

The budgets live in `scripts/bundle-budget/budgets.json`. Here 1 KB = 1000 bytes, the same unit Vite prints.

## What it measures

- **Input.** It reads `dist/.vite/manifest.json`, the file Vite writes when the `build.manifest` option is true.
- **What a route loads.** A route is a list of **manifest keys** (`roots`): the HTML entry plus the lazily loaded route module, for example `src/ui/routes/Landing.tsx`. From these roots, the script follows static `imports` transitively. That gives the chunks the browser fetches for first paint.
  - Chunks loaded later through `import()` (`dynamicImports`), such as the homepage preview, are **not** counted.
  - A chunk shared by several roots is counted once.
- **How files are sized.** Each file is gzipped by the script at **level 9** (`zlib`). The manifest records no sizes. The result can differ slightly from the gzip figure Vite prints during a build.
- **Vendor chunk.** It is the JS chunk whose manifest `name` equals `vendor.chunkName`: the `advancedChunks.groups` entry named `vendor`.
- **CSS.** CSS per route is printed for information and is not budgeted.

## Running it

```sh
pnpm build                                  # once build.manifest: true is set in vite.config.ts
node scripts/bundle-budget/check.mjs        # readable table
node scripts/bundle-budget/check.mjs --json # machine-readable result
```

Until `vite.config.ts` enables the manifest, build with the CLI flag instead:

```sh
pnpm exec vite build --manifest && node scripts/bundle-budget/check.mjs
```

The options are `--dist <dir>` (default `dist`), `--manifest <path>` (default `<dist>/.vite/manifest.json`), `--config <path>` and `--json`.

| Exit | Meaning                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Every check passes                                                                                                                                                                           |
| 1    | Over budget, or a configured route root or the `vendor` chunk is missing from the manifest. A missing chunk is a failure, not a pass                                                         |
| 2    | The input can't be used: the manifest is missing or not valid JSON, the config is invalid, a file the manifest lists is missing, an argument is unknown, or the script hit an internal error |

## Who changes what

- **Enabling the manifest.** The first code-splitting PR sets `build.manifest: true` and the `vendor` group under `build.rollupOptions.output.advancedChunks.groups`. That PR also adds each route's lazy module key to `roots` in `budgets.json`.
- **Running it in CI.** The checker runs as a step after `pnpm build` in `.github/workflows/check.yml`.
- **Changing a budget.** A budget change needs the same review as a design-system change. Update DESIGN_SYSTEM §5 and `budgets.json` together; `tests/bundle-budget.test.ts` asserts the shipped values.

## Baseline: app `origin/main` de70415, 27 Sep 2026

Measured with `pnpm exec vite build --manifest` (Node 24.21.0, Vite 8.3.1) and the checker. `vite.config.ts` was not changed.

```
Check                  Budget KB  JS gzip KB  JS raw KB  CSS gzip KB   Status
---------------------  ---------  ----------  ---------  -----------  -------
route /                    90.00      113.66     392.36        14.51     FAIL
route /rooms/:id          125.00      113.66     392.36        14.51     PASS
vendor chunk "vendor"      70.00           -          -            -  MISSING
```

The whole app is one JS chunk today (`assets/index-*.js`), so both routes measure the same 113.66 KB. Vite printed 114.97 KB for the same file because it uses a different compression level. `/` is 23.66 KB over budget, and no `vendor` chunk exists yet. The checker exits 1, which is the expected state until the code split lands.
