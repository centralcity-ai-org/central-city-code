import { registerMigration, type Migration } from '../migrations.js';

/**
 * Per-token cost of Elric's hosted model. Since migration 45 the cost unit
 * is 1 micro-USD (config.ts ELRIC_COST_UNIT_USD), so a token price in USD per million tokens is
 * also its price in units per token.
 *
 * - input (uncached) USD 1 / M, output USD 5 / M;
 * - cache read 0.1x input, 5-minute cache write 1.25x input.
 *
 * The API reports `input_tokens` as the uncached remainder only, so the four counts never overlap.
 * Turns answered by the self-hosted fallback keep GPU-second costing (config.ts rates).
 */
export const ELRIC_ANTHROPIC_PRICES = {
  inputPerMillion: 1,
  outputPerMillion: 5,
  cacheReadMultiplier: 0.1,
  cacheWriteMultiplier: 1.25,
} as const;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/** Units (micro-USD) for one call priced per token; at least 1, rounded up. */
export function anthropicUnits(
  usage: TokenUsage,
  prices: typeof ELRIC_ANTHROPIC_PRICES = ELRIC_ANTHROPIC_PRICES,
): number {
  const n = (value: number | undefined) => (Number.isFinite(value) ? Math.max(0, value!) : 0);
  const input = prices.inputPerMillion;
  const micro =
    n(usage.inputTokens) * input +
    n(usage.outputTokens) * prices.outputPerMillion +
    n(usage.cacheReadInputTokens) * input * prices.cacheReadMultiplier +
    n(usage.cacheCreationInputTokens) * input * prices.cacheWriteMultiplier;
  return Math.max(1, Math.ceil(micro - 1e-9));
}

/**
 * The worst case of one per-token call: `inputTokens` all written to the cache (1.25x, the most
 * expensive input) plus `outputTokens`. Used for the reservation and the per-step estimate.
 */
export function anthropicWorstUnits(inputTokens: number, outputTokens: number): number {
  return anthropicUnits({ inputTokens: 0, outputTokens, cacheCreationInputTokens: inputTokens });
}

/**
 * Characters per token for the pre-call estimate. English is about 3-4 characters per token, but
 * dense text (CJK, emoji, code) gets close to 1-2. Estimating at 2 keeps the reservation check
 * honest for those; for English it overestimates, which only ends a long run a step earlier.
 */
export const ELRIC_ESTIMATE_CHARS_PER_TOKEN = 2;
/** Estimated tokens for `chars` characters of prompt (rounded up). */
export const estimateTokens = (chars: number) =>
  Math.ceil(Math.max(0, chars) / ELRIC_ESTIMATE_CHARS_PER_TOKEN);

/** The old unit (USD 0.0025) in new units (USD 0.000001). */
export const ELRIC_UNIT_RESCALE = 2500;

/**
 * Migration 45 `elric_token_cost`:
 * - the cost unit becomes 1 micro-USD: every stored unit amount is multiplied by 2500, so history
 *   keeps its dollar value. `elric_turns` is append-only; this one migration bypasses its trigger
 *   for the rescale only (inside the migration transaction) and turns it back on;
 * - `elric_turns.cache_read_tokens` / `cache_write_tokens`: the API's cache counts per turn.
 */
export const elricTokenCostMigration: Migration = {
  version: 45,
  name: 'elric_token_cost',
  sql: `
ALTER TABLE elric_turns ADD COLUMN IF NOT EXISTS cache_read_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE elric_turns ADD COLUMN IF NOT EXISTS cache_write_tokens integer NOT NULL DEFAULT 0;
ALTER TABLE elric_turns DISABLE TRIGGER elric_turns_append_only;
UPDATE elric_turns SET cost_units = cost_units * ${ELRIC_UNIT_RESCALE},
  reserved_units = reserved_units * ${ELRIC_UNIT_RESCALE};
ALTER TABLE elric_turns ENABLE TRIGGER elric_turns_append_only;
UPDATE elric_usage SET reserved_units = reserved_units * ${ELRIC_UNIT_RESCALE},
  spent_units = spent_units * ${ELRIC_UNIT_RESCALE};
UPDATE elric_global_usage SET reserved_units = reserved_units * ${ELRIC_UNIT_RESCALE},
  spent_units = spent_units * ${ELRIC_UNIT_RESCALE};
UPDATE elric_invocations SET reserved_units = reserved_units * ${ELRIC_UNIT_RESCALE},
  spent_units = spent_units * ${ELRIC_UNIT_RESCALE},
  inflight_units = inflight_units * ${ELRIC_UNIT_RESCALE};
UPDATE elric_cost_erased SET cost_units = cost_units * ${ELRIC_UNIT_RESCALE};
`,
};

/** Registered next to migration 44 (registerElricEraseMigration), never on import. */
export function registerElricTokenCostMigration(): void {
  registerMigration(elricTokenCostMigration);
}
