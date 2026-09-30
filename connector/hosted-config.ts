/** Private machine access, scoped to one operator-verified application origin. */
export interface HostedAppConfig {
  readonly origin: string;
  readonly protectionBypassToken: string;
}

function invalid(): never {
  throw new Error('Invalid hosted app configuration.');
}

/** Require canonical spelling before attaching any credentials; never normalize user input. */
export function validateHostedAppOrigin(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (url.protocol !== 'https:' || value !== url.origin) invalid();
  return url;
}

export function validateHostedAppConfig(value: unknown, baseUrl: string): HostedAppConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const fields = value as Record<string, unknown>;
  if (
    Object.keys(fields).length !== 2 ||
    Object.keys(fields).some((key) => !['origin', 'protectionBypassToken'].includes(key)) ||
    typeof fields.protectionBypassToken !== 'string' ||
    fields.protectionBypassToken.length < 16 ||
    fields.protectionBypassToken.length > 512 ||
    /[^\x21-\x7e]/.test(fields.protectionBypassToken)
  )
    invalid();
  const origin = validateHostedAppOrigin(fields.origin).origin;
  if (baseUrl !== origin) invalid();
  return Object.freeze({ origin, protectionBypassToken: fields.protectionBypassToken });
}

/** Only the documented header is supported. No cookies, URL secrets or arbitrary headers. */
export function hostedAppHeaders(
  value: HostedAppConfig | undefined,
  baseUrl: string,
  target: URL,
): Record<string, string> {
  if (value === undefined) return {};
  const config = validateHostedAppConfig(value, baseUrl);
  if (target.origin !== config.origin) invalid();
  return { 'x-vercel-protection-bypass': config.protectionBypassToken };
}
