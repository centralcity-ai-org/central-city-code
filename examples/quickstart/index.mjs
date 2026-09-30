import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

export const DEFAULT_ORIGIN = 'http://127.0.0.1:4310';
const AGENT = 'template:extractor@1.0.0';
const TEAM = 'template:research-team@1.0.0';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseOptions(args) {
  const options = { origin: DEFAULT_ORIGIN, idempotencyKey: randomUUID() };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--origin', '--idempotency-key'].includes(key) || seen.has(key) || !args[i + 1])
      throw new Error('Use --origin <origin> and optionally --idempotency-key <UUID v4>.');
    seen.add(key);
    options[key === '--origin' ? 'origin' : 'idempotencyKey'] = args[++i];
  }
  options.origin = validateOrigin(options.origin);
  if (!UUID.test(options.idempotencyKey)) throw new Error('The idempotency key must be a UUID v4.');
  return options;
}

function validateOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Supply a valid origin.');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    !(url.protocol === 'https:' || (loopback && url.protocol === 'http:'))
  )
    throw new Error('Use an HTTPS origin, or HTTP loopback, without credentials, path or query.');
  return url.origin;
}

/** Creates one zero-cost unclaimed agent; output deliberately excludes raw tool responses. */
export async function runQuickstart({
  origin = DEFAULT_ORIGIN,
  idempotencyKey = randomUUID(),
} = {}) {
  origin = validateOrigin(origin);
  if (!UUID.test(idempotencyKey)) throw new Error('The idempotency key must be a UUID v4.');
  const client = new Client({ name: 'central-city-quickstart', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp/open`), {
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(15000),
        ]),
      }),
  });
  let step = 'connect';
  try {
    await client.connect(transport);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      if (result.isError || !result.structuredContent) throw new Error('Tool refused request.');
      return result.structuredContent;
    };
    step = 'list templates';
    const templates = await call('city_list_templates', {});
    if (
      !Array.isArray(templates.templates) ||
      ![AGENT, TEAM].every((ref) => templates.templates.some((t) => t.ref === ref))
    )
      throw new Error('Required templates unavailable.');
    step = 'plan the research team';
    const planned = await call('city_plan_team', { template: TEAM });
    if (planned.ok !== true) throw new Error('Plan refused.');
    step = 'create the agent';
    const created = await call('city_create_agent', {
      template: AGENT,
      idempotency_key: idempotencyKey,
    });
    const agentId = created.agent?.id;
    if (
      typeof agentId !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(agentId) ||
      created.mode !== 'unclaimed'
    )
      throw new Error('Unexpected creation response.');
    let claimUrl = null;
    if (created.claim) {
      const claim = new URL(created.claim.claim_url);
      if (
        claim.origin !== origin ||
        claim.pathname !== '/' ||
        claim.search ||
        claim.username ||
        claim.password ||
        !/^#claim=ccclaim_[A-Za-z0-9_-]+$/.test(claim.hash)
      )
        throw new Error('Unexpected claim address.');
      claimUrl = claim.href;
    } else if (created.secrets_already_issued !== true) throw new Error('Missing claim response.');
    return {
      agentId,
      claimUrl,
      replayed: created.secrets_already_issued === true,
      expiry:
        'No automatic time expiry is currently published for claim links. The link is single-use and stops working after claiming or administrative removal.',
    };
  } catch {
    throw new Error(
      `Could not ${step}. Check the origin and server availability. If creation may have reached the server, do not retry with a new key: that can create another agent. A replay does not recover a lost claim link.`,
    );
  } finally {
    await client.close().catch(() => {});
  }
}

export function formatResult(result) {
  return [
    'Templates found. Research-team plan checked (nothing created by planning).',
    `${result.replayed ? 'Existing' : 'Created'} unclaimed extractor agent: ${result.agentId}`,
    result.claimUrl
      ? `Private, single-use claim link: ${result.claimUrl}`
      : 'Already applied. Use the claim link saved from the first response; it is not issued again.',
    result.expiry,
    'Keep the claim link private: anyone holding it can claim the agent. Do not paste it into public issues or logs.',
    'No model was run. Creating an agent record does not connect your ChatGPT/Claude account or prove useful output.',
  ].join('\n');
}
