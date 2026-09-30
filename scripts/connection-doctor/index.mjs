const VERSION = 1;
const BODY_LIMIT_DEFAULT = 65_536;
const METADATA_PATHS = {
  resource: '/.well-known/oauth-protected-resource',
  authorization: '/.well-known/oauth-authorization-server',
};

function check(name, status, message) {
  return { name, status, message };
}

function safeEndpoint(value, origin) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
}

async function boundedBody(response, maxBytes, signal) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const cancelOnAbort = () => {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // The stream can already be closed when the timeout fires.
    }
  };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('body-limit');
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    try {
      await reader.cancel();
    } catch {
      /* response may already be closed */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(merged);
}

async function get(fetchImpl, url, timeoutMs, maxBodyBytes) {
  const controller = new AbortController();
  let timer;
  const operation = (async () => {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
    });
    const body = await boundedBody(response, maxBodyBytes, controller.signal);
    return { response, body };
  })();
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error('timeout');
      error.name = 'AbortError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Performs bounded, unauthenticated GET probes. It never follows redirects or uses credentials. */
export async function runDoctor(
  target,
  { fetchImpl = fetch, timeoutMs = 5000, maxBodyBytes = BODY_LIMIT_DEFAULT } = {},
) {
  const checks = [];
  let url;
  try {
    if (typeof target !== 'string' || target.length > 2048 || /[\u0000-\u001f\u007f]/.test(target))
      throw new Error('invalid');
    url = new URL(target);
    const loopback =
      url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    const authority =
      typeof target === 'string' ? /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(target)?.[1] : undefined;
    const authorityHost = authority?.replace(/:\d+$/, '').toLowerCase();
    const literalLoopback =
      authorityHost === 'localhost' || authorityHost === '127.0.0.1' || authorityHost === '[::1]';
    if (
      !authority ||
      !['https:', ...(loopback && literalLoopback ? ['http:'] : [])].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      !Number.isFinite(url.port ? Number(url.port) : 443)
    ) {
      throw new Error('invalid');
    }
    // URL.origin omits an explicit default port and is the sanitized report target.
    target = url.origin;
    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      !Number.isInteger(maxBodyBytes) ||
      maxBodyBytes < 1
    ) {
      throw new Error('invalid');
    }
  } catch {
    return {
      schemaVersion: VERSION,
      observedAt: new Date().toISOString(),
      target: null,
      checks: [
        check(
          'target',
          'fail',
          'Target must be an HTTPS origin (HTTP is allowed for literal loopback only).',
        ),
      ],
      tested: {
        authentication: false,
        userConsent: false,
        runtimeExecution: false,
        modelQuality: false,
      },
      overall: 'fail',
    };
  }
  const origin = target;
  const probe = async (name, path) => {
    try {
      const result = await get(fetchImpl, `${origin}${path}`, timeoutMs, maxBodyBytes);
      return { ...result, failure: null };
    } catch (error) {
      return {
        failure:
          error?.name === 'AbortError'
            ? 'timeout'
            : error?.message === 'body-limit'
              ? 'large'
              : 'unavailable',
      };
    }
  };

  const root = await probe('root', '/');
  checks.push(
    root.failure
      ? check(
          'root',
          'fail',
          root.failure === 'timeout'
            ? 'Root request timed out.'
            : root.failure === 'large'
              ? 'Root response exceeded the body limit.'
              : 'Root request failed.',
        )
      : check(
          'root',
          root.response.status >= 200 && root.response.status < 300 ? 'pass' : 'fail',
          root.response.status >= 200 && root.response.status < 300
            ? 'Root endpoint responded successfully.'
            : 'Root endpoint did not return a successful status.',
        ),
  );

  const metadata = {};
  for (const [key, path] of Object.entries(METADATA_PATHS)) {
    const result = await probe(key, path);
    if (result.failure) {
      checks.push(
        check(
          `${key}-metadata`,
          'fail',
          result.failure === 'timeout'
            ? 'Metadata request timed out.'
            : result.failure === 'large'
              ? 'Metadata response exceeded the body limit.'
              : 'Metadata request failed.',
        ),
      );
      metadata[key] = null;
      continue;
    }
    if (result.response.status < 200 || result.response.status >= 300) {
      checks.push(
        check(`${key}-metadata`, 'fail', 'Metadata endpoint did not return a successful status.'),
      );
      metadata[key] = null;
      continue;
    }
    try {
      metadata[key] = JSON.parse(result.body);
      checks.push(check(`${key}-metadata`, 'pass', 'Metadata is valid JSON.'));
    } catch {
      metadata[key] = null;
      checks.push(check(`${key}-metadata`, 'fail', 'Metadata response was not valid JSON.'));
    }
  }

  if (metadata.resource) {
    const servers = metadata.resource.authorization_servers;
    const valid =
      metadata.resource.resource === `${origin}/mcp` &&
      Array.isArray(servers) &&
      servers.length === 1 &&
      servers[0] === origin;
    checks.push(
      check(
        'resource-metadata-contract',
        valid ? 'pass' : 'fail',
        valid
          ? 'Protected resource identifies this origin and /mcp.'
          : 'Protected-resource metadata did not identify this origin and /mcp.',
      ),
    );
  } else
    checks.push(
      check(
        'resource-metadata-contract',
        'unknown',
        'Could not validate protected-resource metadata.',
      ),
    );

  if (metadata.authorization) {
    const auth = metadata.authorization;
    const valid =
      auth.issuer === origin &&
      auth.authorization_endpoint === `${origin}/oauth/authorize` &&
      auth.token_endpoint === `${origin}/oauth/token` &&
      safeEndpoint(auth.authorization_endpoint, origin) &&
      safeEndpoint(auth.token_endpoint, origin) &&
      Array.isArray(auth.response_types_supported) &&
      auth.response_types_supported.includes('code') &&
      Array.isArray(auth.grant_types_supported) &&
      auth.grant_types_supported.includes('authorization_code') &&
      Array.isArray(auth.code_challenge_methods_supported) &&
      auth.code_challenge_methods_supported.includes('S256') &&
      Array.isArray(auth.token_endpoint_auth_methods_supported) &&
      auth.token_endpoint_auth_methods_supported.includes('none');
    checks.push(
      check(
        'authorization-metadata-contract',
        valid ? 'pass' : 'fail',
        valid
          ? 'Authorization metadata matches the expected issuer, endpoint paths, and mechanisms.'
          : 'Authorization metadata does not match the expected issuer, endpoint paths, or supported mechanisms.',
      ),
    );
  } else
    checks.push(
      check(
        'authorization-metadata-contract',
        'unknown',
        'Could not validate authorization-server metadata.',
      ),
    );

  const mcp = await probe('mcp', '/mcp');
  if (mcp.failure)
    checks.push(
      check(
        'mcp-auth-challenge',
        'fail',
        mcp.failure === 'timeout'
          ? 'MCP challenge request timed out.'
          : mcp.failure === 'large'
            ? 'MCP challenge response exceeded the body limit.'
            : 'MCP challenge request failed.',
      ),
    );
  else {
    const challenge = mcp.response.headers.get('www-authenticate') || '';
    const expected = `${origin}${METADATA_PATHS.resource}`;
    const match = /^Bearer[ \t]+resource_metadata[ \t]*=[ \t]*"([^"\r\n]+)"[ \t]*$/i.exec(
      challenge,
    );
    const hasChallenge = mcp.response.status === 401 && match?.[1] === expected;
    checks.push(
      check(
        'mcp-auth-challenge',
        hasChallenge ? 'pass' : 'fail',
        hasChallenge
          ? 'MCP endpoint advertises its protected-resource metadata.'
          : 'MCP endpoint did not return the expected Bearer resource_metadata challenge.',
      ),
    );
  }
  const overall = checks.every((item) => item.status === 'pass') ? 'pass' : 'fail';
  return {
    schemaVersion: VERSION,
    observedAt: new Date().toISOString(),
    target: origin,
    checks,
    overall,
    tested: {
      authentication: false,
      userConsent: false,
      runtimeExecution: false,
      modelQuality: false,
    },
    note: 'GET probes do not prove full MCP conformity or third-party client support.',
  };
}
