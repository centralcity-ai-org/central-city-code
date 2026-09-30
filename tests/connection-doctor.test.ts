import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runDoctor } from '../scripts/connection-doctor/index.mjs';

const origin = 'https://centralcity.example';
const validAuthorization = {
  issuer: origin,
  authorization_endpoint: `${origin}/oauth/authorize`,
  token_endpoint: `${origin}/oauth/token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
};
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
function fixture(
  targetOrigin = origin,
  overrides: Record<string, (url: string) => Response | Promise<Response>> = {},
) {
  const goodResource = { resource: `${targetOrigin}/mcp`, authorization_servers: [targetOrigin] };
  const goodAuthorization = {
    issuer: targetOrigin,
    authorization_endpoint: `${targetOrigin}/oauth/authorize`,
    token_endpoint: `${targetOrigin}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const override = overrides[path];
    if (override) return override(url);
    if (path === '/') return new Response('ok');
    if (path === '/.well-known/oauth-protected-resource') return json(goodResource);
    if (path === '/.well-known/oauth-authorization-server') return json(goodAuthorization);
    if (path === '/mcp')
      return new Response('', {
        status: 401,
        headers: {
          'www-authenticate': `Bearer resource_metadata="${targetOrigin}/.well-known/oauth-protected-resource"`,
        },
      });
    throw new Error('unexpected request');
  };
  return fetchImpl;
}

test('validates expected read-only endpoint and OAuth discovery baseline', async () => {
  const report = await runDoctor(origin, { fetchImpl: fixture() as typeof fetch });
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.overall, 'pass');
  assert.ok(report.checks.every((item) => item.status === 'pass'));
  assert.deepEqual(report.tested, {
    authentication: false,
    userConsent: false,
    runtimeExecution: false,
    modelQuality: false,
  });
});

test('rejects paths, credentials, insecure non-loopback and malformed targets without fetching', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return new Response('');
  }) as typeof fetch;
  for (const target of [
    'https://user:secret@example.com',
    'https://example.test/path',
    'https://example.test/?x=1',
    'http://example.test',
    'http://127.1',
    'http://0x7f000001',
    `https://${'a'.repeat(2050)}.example`,
    'https://example.test\n/path',
    'not a url',
  ]) {
    const report = await runDoctor(target, { fetchImpl });
    assert.equal(report.overall, 'fail');
    assert.equal(report.target, null);
  }
  assert.equal(calls, 0);
});

test('rejects malformed metadata and a cross-origin token endpoint', async () => {
  const malformed = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/.well-known/oauth-protected-resource': () => new Response('{bad'),
    }) as typeof fetch,
  });
  assert.equal(malformed.checks.find((item) => item.name === 'resource-metadata')?.status, 'fail');
  assert.equal(
    malformed.checks.find((item) => item.name === 'resource-metadata-contract')?.status,
    'unknown',
  );

  const foreign = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/.well-known/oauth-authorization-server': () =>
        json({ ...validAuthorization, token_endpoint: 'https://attacker.example/token' }),
    }) as typeof fetch,
  });
  assert.equal(
    foreign.checks.find((item) => item.name === 'authorization-metadata-contract')?.status,
    'fail',
  );
});

test('fails closed on redirects and missing or mismatched authentication challenge', async () => {
  const redirect = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/': () =>
        new Response('', { status: 302, headers: { location: 'https://elsewhere.example' } }),
    }) as typeof fetch,
  });
  assert.equal(redirect.checks.find((item) => item.name === 'root')?.status, 'fail');
  const missing = await runDoctor(origin, {
    fetchImpl: fixture(origin, { '/mcp': () => new Response('', { status: 401 }) }) as typeof fetch,
  });
  assert.equal(missing.checks.find((item) => item.name === 'mcp-auth-challenge')?.status, 'fail');
  const foreign = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/mcp': () =>
        new Response('', {
          status: 401,
          headers: {
            'www-authenticate': `Bearer notresource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        }),
    }) as typeof fetch,
  });
  assert.equal(foreign.checks.find((item) => item.name === 'mcp-auth-challenge')?.status, 'fail');
});

test('does not parse metadata URLs inside quoted values or a later Basic challenge', async () => {
  const misleadingChallenges = [
    `Bearer realm="text resource_metadata=\"${origin}/.well-known/oauth-protected-resource\""`,
    `Bearer realm="normal", Basic resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
  ];
  for (const challenge of misleadingChallenges) {
    const report = await runDoctor(origin, {
      fetchImpl: fixture(origin, {
        '/mcp': () => new Response('', { status: 401, headers: { 'www-authenticate': challenge } }),
      }) as typeof fetch,
    });
    assert.equal(report.checks.find((item) => item.name === 'mcp-auth-challenge')?.status, 'fail');
  }
});

test('bounds hung requests and oversized bodies with fixed diagnostics', async () => {
  const hung = await runDoctor(origin, {
    timeoutMs: 10,
    fetchImpl: (async () => new Promise<Response>(() => {})) as typeof fetch,
  });
  assert.equal(
    hung.checks.find((item) => item.name === 'root')?.message,
    'Root request timed out.',
  );
  const large = await runDoctor(origin, { maxBodyBytes: 4, fetchImpl: fixture() as typeof fetch });
  assert.equal(
    large.checks.find((item) => item.name === 'resource-metadata')?.message,
    'Metadata response exceeded the body limit.',
  );
  assert.ok(JSON.stringify(hung).length < 2000);
});

test('requires every advertised protected-resource server and OAuth authorization capability', async () => {
  const extraServer = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/.well-known/oauth-protected-resource': () =>
        json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin, 'https://attacker.example'],
        }),
    }) as typeof fetch,
  });
  assert.equal(
    extraServer.checks.find((item) => item.name === 'resource-metadata-contract')?.status,
    'fail',
  );

  for (const omitted of [
    'response_types_supported',
    'grant_types_supported',
    'code_challenge_methods_supported',
    'token_endpoint_auth_methods_supported',
  ] as const) {
    const values = {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    };
    const metadata = { ...values, [omitted]: [] };
    const report = await runDoctor(origin, {
      fetchImpl: fixture(origin, {
        '/.well-known/oauth-authorization-server': () => json(metadata),
      }) as typeof fetch,
    });
    assert.equal(
      report.checks.find((item) => item.name === 'authorization-metadata-contract')?.status,
      'fail',
      omitted,
    );
  }
  const wrongPath = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/.well-known/oauth-authorization-server': () =>
        json({
          issuer: origin,
          authorization_endpoint: `${origin}/wrong`,
          token_endpoint: `${origin}/wrong-token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
    }) as typeof fetch,
  });
  assert.equal(
    wrongPath.checks.find((item) => item.name === 'authorization-metadata-contract')?.status,
    'fail',
  );
});

test('uses explicit GET with manual redirects, accepts literal loopback, and bounds hanging response bodies', async () => {
  const options: RequestInit[] = [];
  const observingFetch = fixture(origin) as typeof fetch;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    options.push(init ?? {});
    return observingFetch(input, init);
  }) as typeof fetch;
  const report = await runDoctor('http://localhost:4310', {
    fetchImpl: fixture('http://localhost:4310') as typeof fetch,
  });
  assert.equal(report.overall, 'pass');
  for (const loopback of ['http://127.0.0.1:4310', 'http://[::1]:4310']) {
    const loopbackReport = await runDoctor(loopback, {
      fetchImpl: fixture(loopback) as typeof fetch,
    });
    assert.equal(loopbackReport.overall, 'pass');
  }
  await runDoctor(origin, { fetchImpl: wrapped });
  assert.equal(options.length, 4);
  assert.ok(
    options.every(
      (item) =>
        item.method === 'GET' &&
        item.redirect === 'manual' &&
        item.signal instanceof AbortSignal &&
        item.body === undefined &&
        item.headers === undefined &&
        item.credentials === undefined,
    ),
  );

  const hangingStreamFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (new URL(String(_input)).pathname !== '/') return fixture()(String(_input), init);
    return new Response(
      new ReadableStream({
        pull() {
          return new Promise<void>(() => {});
        },
        cancel() {
          return Promise.reject(new Error('synthetic cancel rejection'));
        },
      }),
    );
  }) as typeof fetch;
  const timedBody = await runDoctor(origin, { timeoutMs: 10, fetchImpl: hangingStreamFetch });
  assert.equal(
    timedBody.checks.find((item) => item.name === 'root')?.message,
    'Root request timed out.',
  );
});

test('keeps untrusted bodies, headers, and fetch errors out of reports; CLI rejects invalid invocations', async () => {
  const secret = 'synthetic-secret-must-not-appear';
  const report = await runDoctor(origin, {
    fetchImpl: fixture(origin, {
      '/': () =>
        new Response(secret, {
          status: 503,
          headers: { location: `https://attacker.example/${secret}` },
        }),
      '/.well-known/oauth-protected-resource': () => {
        throw new Error(secret);
      },
    }) as typeof fetch,
  });
  assert.equal(JSON.stringify(report).includes(secret), false);

  const cli = fileURLToPath(new URL('../scripts/connection-doctor/cli.mjs', import.meta.url));
  const invalidTarget = spawnSync(process.execPath, [cli, 'http://example.com'], {
    encoding: 'utf8',
  });
  assert.equal(invalidTarget.status, 2);
  const unknownOption = spawnSync(process.execPath, [cli, 'https://example.com', '--unknown'], {
    encoding: 'utf8',
  });
  assert.equal(unknownOption.status, 2);
  assert.equal(unknownOption.stdout.includes('https://example.com'), false);
});
