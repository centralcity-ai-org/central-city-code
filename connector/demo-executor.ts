import { createHash } from 'node:crypto';
import type { Executor } from './index.js';

/** Local text processing only: no language model, browsing, or claims of fact checking. */
export const deterministicExecutor: Executor = async (job, { signal }) => {
  signal.throwIfAborted();
  const text = job.input;
  const unique = (items: string[]) => [...new Set(items)].slice(0, 40);
  const urls = unique(text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []);
  const emails = unique(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []);
  const amounts = unique(
    text.match(/(?:[$€£]\s?\d[\d,.]*|\b\d[\d,.]*\s?(?:USD|EUR|GBP)\b)/g) ?? [],
  );
  const common = {
    execution: 'deterministic-native-connector',
    inputSha256: createHash('sha256').update(text).digest('hex'),
    source: 'User-supplied text only; URLs are not fetched.',
  };
  if (job.capability === 'extract')
    return {
      ...common,
      urls,
      emails,
      amounts,
      keyValuePairs: text
        .split('\n')
        .filter((line) => /^.{1,60}:\s*\S/.test(line))
        .slice(0, 30)
        .map((line) => {
          const delimiter = line.indexOf(':');
          return {
            key: line.slice(0, delimiter).trim(),
            value: line
              .slice(delimiter + 1)
              .trim()
              .slice(0, 240),
          };
        }),
    };
  if (job.capability === 'verify') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* A text report can be valid input. */
    }
    return {
      ...common,
      checks: {
        nonEmpty: text.trim().length > 0,
        validJson: parsed !== undefined,
        objectJson: typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
        containsSourceUrl: urls.length > 0,
      },
      limitation: 'Structural checks only; no independent factual verification.',
    };
  }
  return {
    ...common,
    title: 'Source text brief',
    excerpts: text
      .split(/\n+|(?<=[.!?])\s+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 6)
      .map((line) => line.slice(0, 360)),
    referencedUrls: urls,
    limitation: 'Extractive text demonstration; no new research or factual validation.',
  };
};
