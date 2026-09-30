import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writePublicDocs } from './scripts/public-docs/build';

const fontSource = 'src/shell/fonts/inter-latin-wght-normal.woff2';

/**
 * Preloads the one font file (DESIGN_SYSTEM §1.2) by its built, hashed URL, so it can be cached
 * as immutable. In dev the unhashed source path is preloaded instead.
 */
function preloadFont(): Plugin {
  const tag = (href: string) => ({
    tag: 'link',
    attrs: { rel: 'preload', href, as: 'font', type: 'font/woff2', crossorigin: '' },
    injectTo: 'head' as const,
  });
  return {
    name: 'central-city:preload-font',
    transformIndexHtml(_html, context) {
      if (!context.bundle) return [tag(`/${fontSource}`)];
      const asset = Object.values(context.bundle).find(
        (output) =>
          output.type === 'asset' &&
          output.originalFileNames.some((name) => name.endsWith(fontSource)),
      );
      if (!asset) throw new Error(`preload-font: ${fontSource} is not in the bundle`);
      return [tag(`/${asset.fileName}`)];
    },
  };
}

/**
 * Writes the public Markdown docs for AIs (dist/docs/*.md, dist/docs.md) from docs/*.md after
 * the bundle; see scripts/public-docs/build.ts. A page that fails the public-safety check fails
 * the build.
 */
function publicDocs(): Plugin {
  return {
    name: 'central-city:public-docs',
    apply: 'build',
    writeBundle(options) {
      writePublicDocs(fileURLToPath(new URL('.', import.meta.url)), options.dir ?? 'dist');
    },
  };
}

/**
 * Workers have no DOM. `decode-named-character-reference` (used by the Markdown parser, which runs
 * only in src/rooms/markdown/parse.worker.ts) picks a DOM-based build under the browser
 * condition, which throws in a worker. Alias it to its plain build, resolved from the parser's
 * own dependency chain (pnpm keeps it a transitive dependency).
 */
const fromParser = [
  'mdast-util-from-markdown',
  'micromark-util-decode-string',
  'decode-named-character-reference',
].reduce((base, name) => createRequire(base).resolve(name), fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), preloadFont(), publicDocs()],
  resolve: { alias: [{ find: /^decode-named-character-reference$/, replacement: fromParser }] },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    // scripts/bundle-budget/check.mjs reads dist/.vite/manifest.json (DESIGN_SYSTEM §5, E4).
    manifest: true,
    // Keep the font a separate, hashed file even though it is small enough to inline.
    assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined),
    rolldownOptions: {
      output: {
        // The vendor chunk (react, react-dom, scheduler), cached across deploys and routes.
        // codeSplitting.groups is the current name of advancedChunks.groups in Rolldown.
        codeSplitting: {
          groups: [
            {
              name: 'vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
});
