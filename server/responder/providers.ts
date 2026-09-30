import type { Provider } from './models.js';

/**
 * Provider calls for the hosted responder. S1 has only the key validation call: a free
 * `GET /v1/models/{model}` that proves the key authenticates and can see the chosen model. It does
 * not prove quota or credit; that surfaces on the first reply (S2).
 *
 * Rules (docs/RESPONDER.md): fixed hosts only, https, no redirects, a strict timeout,
 * the response body is discarded unread (OpenAI's 401 body echoes a masked key), and errors map to
 * fixed codes. Plain fetch, not the provider SDKs: no env-driven debug logging, no hidden retries.
 */
export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
}
/** Returns the HTTP status only; rejects on network errors and timeouts. */
export type ProviderTransport = (
  request: ProviderRequest,
  timeoutMs: number,
) => Promise<{ status: number }>;

export const fetchTransport: ProviderTransport = async (request, timeoutMs) => {
  const response = await fetch(request.url, {
    method: 'GET',
    headers: request.headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel().catch(() => {});
  return { status: response.status };
};

export const VALIDATION_TIMEOUT_MS = 5000;

export function validationRequest(
  provider: Provider,
  model: string,
  apiKey: string,
): ProviderRequest {
  const id = encodeURIComponent(model);
  return provider === 'anthropic'
    ? {
        url: `https://api.anthropic.com/v1/models/${id}`,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      }
    : {
        url: `https://api.openai.com/v1/models/${id}`,
        headers: { authorization: `Bearer ${apiKey}` },
      };
}

export type ValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'invalid_key' | 'forbidden_key' | 'model_unavailable' | 'provider_unreachable';
    };

export function mapValidationStatus(status: number): ValidationResult {
  if (status === 200) return { ok: true };
  if (status === 401) return { ok: false, code: 'invalid_key' };
  if (status === 403) return { ok: false, code: 'forbidden_key' };
  if (status === 404) return { ok: false, code: 'model_unavailable' };
  return { ok: false, code: 'provider_unreachable' };
}

/**
 * Key format check before any network call. Admin keys are refused: they manage an organization and
 * must never be handed to a service.
 */
export function checkKeyFormat(
  provider: Provider,
  key: Buffer,
): 'ok' | 'invalid_key_format' | 'unsupported_key' {
  const text = key.toString('latin1');
  if (key.length < 20 || key.length > 256 || !/^[A-Za-z0-9_-]+$/.test(text))
    return 'invalid_key_format';
  if (provider === 'anthropic') {
    if (text.startsWith('sk-ant-admin')) return 'unsupported_key';
    return text.startsWith('sk-ant-api') ? 'ok' : 'invalid_key_format';
  }
  if (text.startsWith('sk-admin-')) return 'unsupported_key';
  return text.startsWith('sk-') ? 'ok' : 'invalid_key_format';
}

// ---------------------------------------------------------------------------------------------
// Replies (S2b): one POST per mention, no tools, text only.

export interface ProviderPostRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}
/**
 * Sends one request and returns the status, `retry-after` and the parsed JSON body (at most
 * 1 MB). Rejects with `sent: false` when the request never left (DNS/connect), else `sent: true`
 * (a timeout or reset after sending: the provider may have billed; review N4).
 */
export type ProviderPostTransport = (
  request: ProviderPostRequest,
  timeoutMs: number,
) => Promise<{ status: number; retryAfterMs: number | null; json: unknown }>;

export class ProviderTransportError extends Error {
  constructor(readonly sent: boolean) {
    super(sent ? 'provider_timeout' : 'provider_unreachable');
  }
}

const MAX_BODY = 1_000_000;
export const fetchPostTransport: ProviderPostTransport = async (request, timeoutMs) => {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Undici reports connect failures as a TypeError with a cause code; anything else (abort,
    // timeout) may have reached the provider. The error itself is never logged or kept.
    const code = (error as { cause?: { code?: string } }).cause?.code ?? '';
    throw new ProviderTransportError(
      !/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code),
    );
  }
  const retry = Number(response.headers.get('retry-after'));
  let json: unknown = null;
  try {
    const text = await response.text();
    json = text.length <= MAX_BODY ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    retryAfterMs: Number.isFinite(retry) && retry > 0 ? Math.min(retry, 120) * 1000 : null,
    json,
  };
};

export type ReplyErrorCode =
  | 'invalid_key'
  | 'forbidden'
  | 'model_unavailable'
  | 'quota'
  | 'rate_limited'
  | 'server_error'
  | 'too_large'
  | 'bad_request'
  | 'timeout'
  | 'unreachable';

export type ModelResult =
  | {
      ok: true;
      /** Empty when the model refused or produced no text. */
      text: string;
      refused: boolean;
      truncated: boolean;
      inputTokens: number;
      outputTokens: number;
      /** Cache writes and reads (Anthropic), charged at the input price as an upper bound. */
      cacheTokens: number;
    }
  | { ok: false; code: ReplyErrorCode; retryAfterMs: number | null; billedMaybe: boolean };

export interface ModelCall {
  provider: Provider;
  model: string;
  maxOutputTokens: number;
  effort?: 'low';
  system: string;
  user: string;
}

export function modelRequest(call: ModelCall, apiKey: string): ProviderPostRequest {
  if (call.provider === 'anthropic')
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: call.model,
        max_tokens: call.maxOutputTokens,
        system: call.system,
        messages: [{ role: 'user', content: call.user }],
        ...(call.effort ? { output_config: { effort: call.effort } } : {}),
      }),
    };
  return {
    url: 'https://api.openai.com/v1/chat/completions',
    headers: { authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: call.model,
      n: 1,
      max_completion_tokens: call.maxOutputTokens,
      messages: [
        { role: 'system', content: call.system },
        { role: 'user', content: call.user },
      ],
    }),
  };
}

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * Maps a provider answer to a fixed result. Error bodies are inspected only for fixed type/code
 * fields (and Anthropic's credit-balance message by a fixed substring); nothing from them is kept.
 */
export function mapModelResponse(
  provider: Provider,
  answer: { status: number; retryAfterMs: number | null; json: unknown },
): ModelResult {
  const body = (answer.json ?? {}) as Record<string, unknown>;
  const error = (body.error ?? {}) as { type?: unknown; code?: unknown; message?: unknown };
  const fail = (code: ReplyErrorCode, billedMaybe = false): ModelResult => ({
    ok: false,
    code,
    retryAfterMs: answer.retryAfterMs,
    billedMaybe,
  });
  const { status } = answer;
  if (status === 200) {
    if (provider === 'anthropic') {
      const content = Array.isArray(body.content) ? body.content : [];
      const text = content
        .filter((block: { type?: unknown }) => block?.type === 'text')
        .map((block: { text?: unknown }) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
        .trim();
      const usage = (body.usage ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        text,
        refused: body.stop_reason === 'refusal',
        truncated: body.stop_reason === 'max_tokens',
        inputTokens: num(usage.input_tokens),
        outputTokens: num(usage.output_tokens),
        cacheTokens: num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
      };
    }
    const choice = (Array.isArray(body.choices) ? body.choices[0] : undefined) as
      { message?: { content?: unknown }; finish_reason?: unknown } | undefined;
    const usage = (body.usage ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      text: typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '',
      refused: choice?.finish_reason === 'content_filter',
      truncated: choice?.finish_reason === 'length',
      inputTokens: num(usage.prompt_tokens),
      outputTokens: num(usage.completion_tokens),
      cacheTokens: 0,
    };
  }
  if (status === 401) return fail('invalid_key');
  if (status === 403) return fail('forbidden');
  if (status === 404) return fail('model_unavailable');
  if (status === 402) return fail('quota');
  if (status === 413) return fail('too_large');
  if (status === 429)
    return provider === 'openai' && error.code === 'insufficient_quota'
      ? fail('quota')
      : fail('rate_limited');
  if (status === 400) {
    if (
      provider === 'anthropic' &&
      typeof error.message === 'string' &&
      /credit balance is too low/i.test(error.message)
    )
      return fail('quota');
    if (provider === 'openai' && error.code === 'context_length_exceeded') return fail('too_large');
    return fail('bad_request');
  }
  if (status >= 500) return fail('server_error', true);
  return fail('server_error');
}

/** One reply call. Never throws; the API key string lives only for the request. */
export async function callModel(
  transport: ProviderPostTransport,
  call: ModelCall,
  apiKey: Buffer,
  timeoutMs: number,
): Promise<ModelResult> {
  try {
    const answer = await transport(modelRequest(call, apiKey.toString('latin1')), timeoutMs);
    return mapModelResponse(call.provider, answer);
  } catch (error) {
    const sent = error instanceof ProviderTransportError ? error.sent : true;
    return {
      ok: false,
      code: sent ? 'timeout' : 'unreachable',
      retryAfterMs: null,
      billedMaybe: sent,
    };
  }
}
