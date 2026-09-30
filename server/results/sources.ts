import { RESULT_CONFIG, type SourceInput, type StoredSource } from './contract.js';

/**
 * Source URL rules (docs/ANSWERS.md). Only https URLs without userinfo are
 * accepted; the query string and fragment are dropped before storing. A secret in the path is
 * not removed by that, so such sources are refused (never silently rewritten):
 * - Central City's own origin is accepted only for /results/<id> and /a2a/<agent_id>;
 * - a pinned denylist of known secret-in-path patterns (reviewed at each release);
 * - token-shaped path segments (see tokenShaped; pure hex of at most 64 characters, such as
 *   commit SHAs and content hashes, stays allowed).
 * Hosts are compared normalized (normalizeHost): lowercase, no trailing dot, no leading "www.".
 * The denylist catches known patterns; it cannot prove a URL is safe. Residual risk: a secret that
 * is pure hex (at most 64 characters) or not token-shaped passes.
 */
export interface SourceIssue {
  code: 'source_invalid' | 'source_not_https' | 'source_userinfo' | 'source_secret_path';
  path: string;
  message: string;
  hint: string;
}

/** Central City itself (and every subdomain), besides the deployment's own origins. */
const APP_DOMAIN = 'centralcity.ai';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_SEGMENT = new RegExp(`^${UUID}$`, 'i');
/**
 * Host comparison form: lowercase, without trailing dots (a fully qualified name such as
 * "hooks.slack.com." is the same host) and without a leading "www.".
 */
export function normalizeHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/^www\./, '');
}
const APP_ALLOWED = [
  new RegExp(`^/results/${UUID}/?$`, 'i'),
  new RegExp(`^/a2a/${UUID}(?:/\\.well-known/agent-card\\.json)?/?$`, 'i'),
];

/**
 * `config.results.sourcePathDenylist`: host (exact, or a suffix with a leading '.') and a path
 * pattern. Any path segment named reset, magic, invite, token, verify or unsubscribe followed by
 * another segment is also refused, on every host.
 */
export const SOURCE_PATH_DENYLIST: ReadonlyArray<{ host: string; path: RegExp; label: string }> = [
  { host: 'hooks.slack.com', path: /^\/services\//i, label: 'Slack webhook' },
  { host: 'discord.com', path: /^\/api\/(?:v\d+\/)?webhooks\//i, label: 'Discord webhook' },
  { host: 'discordapp.com', path: /^\/api\/(?:v\d+\/)?webhooks\//i, label: 'Discord webhook' },
  { host: 'api.telegram.org', path: /^\/(?:file\/)?bot/i, label: 'Telegram bot' },
  { host: 'outlook.office.com', path: /^\/webhook\//i, label: 'Office webhook' },
  { host: '.webhook.office.com', path: /^\/./, label: 'Office webhook' },
  {
    host: 'chat.googleapis.com',
    path: /^\/v1\/spaces\/[^/]+\/messages/i,
    label: 'Google Chat webhook',
  },
  { host: '.zoom.us', path: /^\/(?:j|w|my|s)\//i, label: 'Zoom meeting' },
  { host: 'zoom.us', path: /^\/(?:j|w|my|s)\//i, label: 'Zoom meeting' },
  { host: 'meet.google.com', path: /^\/./, label: 'Google Meet' },
  { host: 'teams.microsoft.com', path: /^\/l\/meetup-join\//i, label: 'Teams meeting' },
  { host: 'dropbox.com', path: /^\/(?:s|scl)\//i, label: 'Dropbox share link' },
  { host: '1drv.ms', path: /^\/./, label: 'OneDrive share link' },
  { host: 'docs.google.com', path: /\/d\//i, label: 'Google Docs link' },
  { host: 'drive.google.com', path: /^\/./, label: 'Google Drive link' },
  { host: 'gist.github.com', path: /^\/[^/]+\/[^/]+/, label: 'GitHub gist' },
];
const SECRET_SEGMENTS = new Set(['reset', 'magic', 'invite', 'token', 'verify', 'unsubscribe']);

function hostMatches(hostname: string, rule: string): boolean {
  return rule.startsWith('.') ? hostname.endsWith(rule) : hostname === rule;
}
/**
 * A likely token: at least 32 characters of [A-Za-z0-9_-] only, and either mixing upper case,
 * lower case and digits, or mixing letters and digits without any '-' or '_' separator. Pure hex
 * of at most 64 characters (commit SHAs, content hashes) stays allowed; UUIDs are refused. Words
 * joined by separators, and segments with any other character ('.', '(' ...), are ordinary paths.
 */
export function tokenShaped(segment: string): boolean {
  if (UUID_SEGMENT.test(segment)) return true;
  if (segment.length < 32 || !/^[A-Za-z0-9_-]+$/.test(segment)) return false;
  if (/^[0-9a-f]+$/i.test(segment) && segment.length <= 64) return false;
  const digits = /[0-9]/.test(segment);
  const mixedCase = /[A-Z]/.test(segment) && /[a-z]/.test(segment) && digits;
  const unseparated = !/[-_]/.test(segment) && /[A-Za-z]/.test(segment) && digits;
  return mixedCase || unseparated;
}

/**
 * Validates and normalizes sources: returns the stored form (origin + path) or the issues.
 * `appOrigins` are the deployment's own origins (the request origin and every hosted allowed
 * origin); they count as Central City like centralcity.ai and its subdomains.
 */
export function normalizeSources(
  sources: readonly SourceInput[],
  appOrigins: readonly string[],
): { sources: StoredSource[]; issues: SourceIssue[] } {
  const issues: SourceIssue[] = [];
  const stored: StoredSource[] = [];
  const appHosts = new Set<string>();
  for (const origin of appOrigins)
    try {
      appHosts.add(normalizeHost(new URL(origin).hostname));
    } catch {
      // Not an origin; ignored.
    }
  const isApp = (host: string) =>
    host === APP_DOMAIN || host.endsWith(`.${APP_DOMAIN}`) || appHosts.has(host);
  sources.forEach((source, index) => {
    const path = `sources.${index}.url`;
    const refuse = (code: SourceIssue['code'], message: string, hint: string) =>
      issues.push({ code, path, message, hint });
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      return refuse('source_invalid', 'Not a valid URL.', 'Use an absolute https URL.');
    }
    if (source.url.length > RESULT_CONFIG.sourceUrlChars)
      return refuse('source_invalid', 'URL is too long.', 'Use at most 2048 characters.');
    if (url.protocol !== 'https:')
      return refuse('source_not_https', 'Only https sources are accepted.', 'Use https.');
    if (url.username || url.password)
      return refuse(
        'source_userinfo',
        'Sources must not contain credentials.',
        'Remove the user:password@ part.',
      );
    const hostname = normalizeHost(url.hostname);
    const pathname = url.pathname;
    const secret = () =>
      refuse(
        'source_secret_path',
        'This URL looks like it carries a secret in its path.',
        'Link to a public page instead; sources are visible to everyone who can see the result.',
      );
    if (isApp(hostname)) {
      if (!APP_ALLOWED.some((pattern) => pattern.test(pathname))) return secret();
    } else {
      let segments: string[];
      try {
        // Decode first and split again, so %2F, %73 or a doubled slash cannot hide a segment.
        segments = pathname
          .split('/')
          .flatMap((segment) => decodeURIComponent(segment).split('/'))
          .filter((segment) => segment !== '');
      } catch {
        return refuse('source_invalid', 'The URL path is malformed.', 'Use a valid URL.');
      }
      const canonical = `/${segments.join('/')}`;
      if (
        SOURCE_PATH_DENYLIST.some(
          (rule) =>
            hostMatches(hostname, rule.host) &&
            (rule.path.test(pathname) || rule.path.test(canonical)),
        )
      )
        return secret();
      if (
        segments.some(
          (segment, at) =>
            SECRET_SEGMENTS.has(segment.toLowerCase()) && (segments[at + 1] ?? '') !== '',
        ) ||
        segments.some(tokenShaped)
      )
        return secret();
    }
    stored.push({
      url: `${url.origin}${pathname}`,
      ...(source.title !== undefined ? { title: source.title } : {}),
      ...(source.retrieved_at !== undefined
        ? { retrieved_at: new Date(source.retrieved_at).toISOString() }
        : {}),
    });
  });
  return { sources: stored, issues };
}
