import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from '@modelcontextprotocol/client';
import { createApp } from '../server/app.js';
import type { ClientMetadataFetcher } from '../server/oauth/clients.js';

export type App = Awaited<ReturnType<typeof createApp>>;
export const ORIGIN = 'http://localhost';
export const RESOURCE = `${ORIGIN}/mcp`;
export const PASSWORD = 'Synthetic oauth owner password';
export const OWNER = 'OAuth owner';
export const REDIRECT = 'http://127.0.0.1:43123/callback';
export const ALL_SCOPES = 'workspace:read agents:create jobs:create jobs:cancel';
const jsonHeaders = { 'content-type': 'application/json', 'x-city-request': '1' };
const formType = 'application/x-www-form-urlencoded';

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export async function fixture(
  t: { after: (fn: () => Promise<unknown>) => void },
  options: { clock?: () => number; fetchClientMetadata?: ClientMetadataFetcher } = {},
) {
  const app = await createApp({
    dataDir: ':memory:',
    startWorkers: false,
    ...(options.clock ? { now: options.clock } : {}),
    remoteMcp: options.fetchClientMetadata
      ? { fetchClientMetadata: options.fetchClientMetadata }
      : {},
  });
  t.after(() => app.close());
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: jsonHeaders,
    payload: JSON.stringify({ name: OWNER, password: PASSWORD }),
  });
  assert.equal(res.statusCode, 201, res.body);
  const cookie = `cc_session=${res.cookies.find((entry) => entry.name === 'cc_session')!.value}`;
  return { app, cookie };
}

export function ownerApi(app: App, cookie: string, url: string, body?: unknown, method?: 'DELETE') {
  return app.inject({
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    url,
    headers: { ...jsonHeaders, cookie },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

export async function registerClient(app: App, redirectUris: string[] = [REDIRECT]) {
  const res = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ client_name: 'Synthetic MCP client', redirect_uris: redirectUris }),
  });
  assert.equal(res.statusCode, 201, res.body);
  return res.json() as { client_id: string; client_name: string; redirect_uris: string[] };
}

export interface AuthorizeParams {
  client_id: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  resource?: string;
}
export function authorizeUrl(params: AuthorizeParams): string {
  const query = new URLSearchParams({
    response_type: 'code',
    redirect_uri: REDIRECT,
    code_challenge_method: 'S256',
    state: 'synthetic-state',
    resource: RESOURCE,
    ...params,
  } as Record<string, string>);
  for (const [key, value] of [...query]) if (value === 'OMIT') query.delete(key);
  return `/oauth/authorize?${query}`;
}

export interface ConsentForm {
  requestId: string;
  csrf: string;
  cookie: string;
  status: number;
  body: string;
}
export async function openAuthorize(app: App, url: string, cookie?: string): Promise<ConsentForm> {
  const res = await app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
  const flow = res.cookies.find((entry) => entry.name.startsWith('cc_oauth_'));
  return {
    status: res.statusCode,
    body: res.body,
    requestId: /name="request_id" value="([^"]+)"/.exec(res.body)?.[1] ?? '',
    csrf: /name="csrf" value="([^"]+)"/.exec(res.body)?.[1] ?? '',
    cookie: flow ? `${flow.name}=${flow.value}` : '',
  };
}

export function postForm(
  app: App,
  url: string,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = {},
  remoteAddress?: string,
) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields))
    for (const item of [value].flat()) body.append(key, item);
  return app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': formType, ...headers },
    payload: body.toString(),
    ...(remoteAddress ? { remoteAddress } : {}),
  });
}

export function consentPost(
  app: App,
  form: ConsentForm,
  fields: Record<string, string | string[]>,
  headers: Record<string, string> = { origin: ORIGIN },
  remoteAddress?: string,
) {
  return postForm(
    app,
    '/oauth/authorize',
    { request_id: form.requestId, csrf: form.csrf, ...fields },
    { cookie: form.cookie, ...headers },
    remoteAddress,
  );
}

export function redirectFrom(body: string): URL {
  const match = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(body);
  assert.ok(match, body);
  return new URL(match[1]!.replaceAll('&amp;', '&'));
}

/** An authorization error for an unverified client: a page with a link, never an auto-redirect. */
export function errorLinkFrom(res: { status: number; body: string }): URL {
  assert.equal(res.status, 400, res.body);
  assert.doesNotMatch(res.body, /http-equiv="refresh"/);
  const match = /<a href="([^"]+)" rel="noreferrer">return to/.exec(res.body);
  assert.ok(match, res.body);
  return new URL(match[1]!.replaceAll('&amp;', '&'));
}

/**
 * Logs in on the consent page and approves; returns the redirect back to the client.
 * `days: null` posts no duration choice at all.
 */
export async function approve(
  app: App,
  url: string,
  options: { scopes?: string[]; days?: string | null } = {},
): Promise<URL> {
  const form = await openAuthorize(app, url);
  assert.equal(form.status, 200, form.body);
  assert.match(form.body, /Operator name/);
  const login = await consentPost(app, form, { action: 'login', name: OWNER, password: PASSWORD });
  assert.equal(login.statusCode, 200, login.body);
  assert.match(login.body, /Allow .* to access Central City/);
  const res = await consentPost(app, form, {
    action: 'approve',
    scope: options.scopes ?? ['agents:create', 'jobs:create', 'jobs:cancel'],
    ...(options.days === null ? {} : { expires_in_days: options.days ?? '7' }),
  });
  assert.equal(res.statusCode, 200, res.body);
  return redirectFrom(res.body);
}

export function tokenRequest(app: App, fields: Record<string, string>, host?: string) {
  return postForm(app, '/oauth/token', fields, host ? { host } : {});
}

export async function fullFlow(
  app: App,
  options: { scopes?: string[]; days?: string | null; scope?: string } = {},
) {
  const client = await registerClient(app);
  const { verifier, challenge } = pkce();
  const back = await approve(
    app,
    authorizeUrl({
      client_id: client.client_id,
      code_challenge: challenge,
      scope: options.scope ?? ALL_SCOPES,
    }),
    options,
  );
  const code = back.searchParams.get('code')!;
  const res = await tokenRequest(app, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    resource: RESOURCE,
  });
  assert.equal(res.statusCode, 200, res.body);
  return {
    client,
    back,
    code,
    verifier,
    tokens: res.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
      scope: string;
      token_type: string;
    },
  };
}

let rpcId = 1;
export function mcpCall(
  app: App,
  token: string | undefined,
  method: string,
  params: unknown = {},
  host?: string,
) {
  return app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(host ? { host } : {}),
    },
    payload: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method, params }),
  });
}

/** Parses a JSON or single-event SSE JSON-RPC response body. */
export function rpcResult(body: string): { result?: any; error?: any } {
  const text = body.trim();
  if (text.startsWith('{')) return JSON.parse(text);
  const data = text
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('');
  return JSON.parse(data);
}

export class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = '';
  discovery?: OAuthDiscoveryState;
  authorizationUrl?: URL;
  get redirectUrl() {
    return REDIRECT;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Official SDK test client',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }
  state() {
    return 'sdk-state';
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
}

/** Drives the consent page like a browser: GET, sign in, approve, follow the refresh. */
export async function consent(
  authorizationUrl: URL,
  scopes: string[] = ['agents:create', 'jobs:create', 'jobs:cancel'],
): Promise<URL> {
  const page = await fetch(authorizationUrl);
  const html = await page.text();
  assert.equal(page.status, 200, html);
  const cookie = page.headers.getSetCookie().find((value) => value.startsWith('cc_oauth_'))!;
  const flowCookie = cookie.split(';')[0]!;
  const requestId = /name="request_id" value="([^"]+)"/.exec(html)![1]!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)![1]!;
  const post = (fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams({ request_id: requestId, csrf });
    for (const [key, value] of Object.entries(fields))
      for (const item of [value].flat()) body.append(key, item);
    return fetch(new URL('/oauth/authorize', authorizationUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: flowCookie,
        origin: authorizationUrl.origin,
      },
      body,
    });
  };
  const login = await post({ action: 'login', name: OWNER, password: PASSWORD });
  assert.equal(login.status, 200, await login.clone().text());
  const approved = await post({
    action: 'approve',
    scope: scopes,
    expires_in_days: '1',
  });
  const text = await approved.text();
  const match = /http-equiv="refresh" content="0;url=([^"]+)"/.exec(text);
  assert.ok(match, text);
  return new URL(match[1]!.replaceAll('&amp;', '&'));
}
