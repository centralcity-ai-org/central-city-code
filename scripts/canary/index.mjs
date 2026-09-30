import { randomUUID } from 'node:crypto';

/** Dedicated synthetic account only. No registration, agent creation or customer cleanup. */
export async function runCanary(config, fetcher = fetch) {
  const { origin, cookie, ownerId, senderId, recipientId } = config;
  const base = new URL(origin);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  )
    throw new Error('Invalid canary origin');
  if (![cookie, ownerId, senderId, recipientId].every((v) => typeof v === 'string' && v.length))
    throw new Error('Missing canary configuration');
  const checks = [];
  async function request(label, path, method = 'GET', body, authenticated = true) {
    try {
      const response = await fetcher(new URL(path, base), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(authenticated ? { cookie, 'x-city-request': '1' } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error('HTTP failure');
      const raw = await response.text();
      const value = response.headers.get('content-type')?.includes('text/event-stream')
        ? JSON.parse(
            raw
              .split('\n')
              .find((line) => line.startsWith('data:') && line.includes('"result"'))
              .slice(5),
          )
        : JSON.parse(raw);
      checks.push(label);
      return value;
    } catch {
      throw new Error(`Canary check failed: ${label}`);
    }
  }
  const session = await request('session', '/api/session');
  if (session.operator?.id !== ownerId || !session.operator?.name?.startsWith('canary-'))
    throw new Error('Canary identity mismatch');
  const conversations = await request('conversations', '/api/messages/conversations?limit=1');
  if (!Array.isArray(conversations.conversations))
    throw new Error('Invalid conversations response');
  const tools = await request(
    'anonymous-mcp',
    '/mcp/open',
    'POST',
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    false,
  );
  const names = tools.result?.tools?.map((t) => t.name);
  if (
    !names?.includes('city_plan_team') ||
    ['city_send_message', 'city_read_inbox', 'city_ack_inbox'].some((n) => names.includes(n))
  )
    throw new Error('Invalid anonymous MCP exposure');
  const sent = await request(
    'send',
    `/api/agents/${encodeURIComponent(senderId)}/messages`,
    'POST',
    {
      to_agent_id: recipientId,
      text: 'Synthetic production canary',
      context_id: 'production-canary',
      idempotency_key: randomUUID(),
    },
  );
  const message = sent.message;
  if (!message?.id || !Number.isSafeInteger(message.seq) || message.seq < 1)
    throw new Error('Invalid send receipt');
  const inbox = await request(
    'read',
    `/api/agents/${encodeURIComponent(recipientId)}/inbox?since=${message.seq - 1}&limit=1`,
  );
  if (!inbox.messages?.some((m) => m.id === message.id && m.seq === message.seq))
    throw new Error('Canary message missing');
  const ack = await request(
    'ack',
    `/api/agents/${encodeURIComponent(recipientId)}/inbox/ack`,
    'POST',
    {
      seq: message.seq,
    },
  );
  if (
    ack.agent_id !== recipientId ||
    !Number.isSafeInteger(ack.acked_seq) ||
    ack.acked_seq < message.seq
  )
    throw new Error('Invalid acknowledgement');
  return { ok: true, checks };
}
