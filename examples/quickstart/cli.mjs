import { parseOptions, runQuickstart, formatResult } from './index.mjs';
try {
  const options = parseOptions(process.argv.slice(2));
  console.log(formatResult(await runQuickstart(options)));
} catch (error) {
  // Only our fixed diagnostics escape; runQuickstart never exposes server errors or responses.
  console.error(error.message);
  process.exitCode = 1;
}
