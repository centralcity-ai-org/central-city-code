import type { Capability } from '../shared/types.js';

/** Bounded, pure local transformations. These demonstrations do not call a model or browse. */
export function executeTemplate(capability: Capability, input: string): Record<string, unknown> {
  const urls = [...new Set(input.match(/https?:\/\/[^\s<>"']+/g) ?? [])].slice(0, 30);
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (capability === 'extract') {
    return {
      execution: 'deterministic-demonstration',
      capability,
      sourceCharacters: input.length,
      fields: lines.slice(0, 50).flatMap((line) => {
        const colon = line.indexOf(':');
        if (colon < 1 || colon > 80 || /^https?:\/\//.test(line)) return [];
        return [
          {
            key: line.slice(0, colon).trim(),
            value: line
              .slice(colon + 1)
              .trim()
              .slice(0, 500),
          },
        ];
      }),
      urls,
      numbers: (input.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? []).slice(0, 50),
      note: 'Pattern extraction from supplied text only. No external sources were fetched.',
    };
  }
  if (capability === 'verify') {
    let jsonValid = false;
    try {
      JSON.parse(input);
      jsonValid = true;
    } catch {
      /* Free text is a valid input. */
    }
    return {
      execution: 'deterministic-demonstration',
      capability,
      checks: [
        { name: 'Nonempty supplied text', passed: input.trim().length > 0 },
        { name: 'Contains source URL', passed: urls.length > 0 },
        { name: 'Valid JSON syntax', passed: jsonValid },
      ],
      sourceCharacters: input.length,
      sourceUrls: urls,
      note: 'Structural checks only. Factual accuracy and source accessibility have not been verified.',
    };
  }
  return {
    execution: 'deterministic-demonstration',
    capability,
    brief: lines.slice(0, 5).map((line) => line.slice(0, 400)),
    sourceUrls: urls,
    sourceCharacters: input.length,
    followUp: urls.length
      ? 'Check the listed sources independently before relying on their claims.'
      : 'Provide source URLs for a source-grounded review.',
    note: 'This brief organizes the supplied text. It does not perform research or generate new factual claims.',
  };
}
