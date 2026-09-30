/**
 * Models an owner may choose for the hosted responder, with list prices used for the spend-cap
 * estimate (docs/RESPONDER.md). A model without a price cannot be chosen: without an
 * estimate there is no spend cap. Prices are micro-USD per million tokens (standard tier).
 *
 * Sources, checked 2026-09-28 (re-check before enabling in production and on every change):
 * - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (base input / output) and the
 *   API IDs from https://platform.claude.com/docs/en/about-claude/models/overview. Haiku 4.5 uses
 *   its dated API ID; its retirement is "not sooner than October 15, 2026", so re-check it then.
 * - OpenAI: https://developers.openai.com/api/docs/pricing (standard input / output columns).
 */
export type Provider = 'openai' | 'anthropic';
export const PROVIDERS = ['openai', 'anthropic'] as const;

export interface ResponderModel {
  provider: Provider;
  id: string;
  name: string;
  inputMicroUsdPerMTok: number;
  outputMicroUsdPerMTok: number;
  /** Output tokens allowed per reply. */
  maxOutputTokens: number;
  /**
   * Anthropic `output_config.effort` to send (models with adaptive, always-on thinking): 'low'
   * keeps replies short and cheap. Omitted for models without effort support.
   */
  effort?: 'low';
}

export const RESPONDER_MODELS: readonly ResponderModel[] = [
  {
    provider: 'anthropic',
    id: 'claude-haiku-4-5-20251001',
    // Retirement "not sooner than October 15, 2026" (Anthropic models overview): selectable, not
    // the default. Remove from the allowlist before it retires.
    name: 'Claude Haiku 4.5 (retiring)',
    inputMicroUsdPerMTok: 1_000_000,
    outputMicroUsdPerMTok: 5_000_000,
    maxOutputTokens: 600,
  },
  {
    provider: 'anthropic',
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 10_000_000,
    maxOutputTokens: 600,
    effort: 'low',
  },
  {
    provider: 'anthropic',
    id: 'claude-opus-5-5',
    name: 'Claude Opus 5.5',
    inputMicroUsdPerMTok: 4_000_000,
    outputMicroUsdPerMTok: 20_000_000,
    maxOutputTokens: 600,
    effort: 'low',
  },
  {
    provider: 'anthropic',
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1',
    inputMicroUsdPerMTok: 10_000_000,
    outputMicroUsdPerMTok: 50_000_000,
    maxOutputTokens: 600,
    effort: 'low',
  },
  {
    provider: 'openai',
    id: 'gpt-6-luna',
    name: 'GPT-6 Luna',
    inputMicroUsdPerMTok: 100_000,
    outputMicroUsdPerMTok: 500_000,
    maxOutputTokens: 600,
  },
  {
    provider: 'openai',
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    inputMicroUsdPerMTok: 750_000,
    outputMicroUsdPerMTok: 4_500_000,
    maxOutputTokens: 600,
  },
  {
    provider: 'openai',
    id: 'gpt-6-sol',
    name: 'GPT-6 Sol',
    inputMicroUsdPerMTok: 2_000_000,
    outputMicroUsdPerMTok: 10_000_000,
    maxOutputTokens: 600,
  },
];

/**
 * The model a new setup starts with, per provider. Anthropic defaults to Sonnet 5 ($2 / $10): cheap
 * enough for short room replies, and not retiring soon (Haiku 4.5 retires no sooner than
 * 2026-10-15, so it stays selectable but is not the default).
 */
export const DEFAULT_MODEL: Record<Provider, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-6-sol',
};

export function findModel(provider: Provider, id: string): ResponderModel | undefined {
  return RESPONDER_MODELS.find((model) => model.provider === provider && model.id === id);
}

/** Typical reply for the UI: a 6,000-token prompt and 400 output tokens, rounded up to a cent. */
export function estimatedCostPerReplyUsd(model: ResponderModel): number {
  const micro = (6000 * model.inputMicroUsdPerMTok + 400 * model.outputMicroUsdPerMTok) / 1_000_000;
  return Math.ceil(micro / 10_000) / 100;
}
