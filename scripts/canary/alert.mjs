/** Uses a separate messages:send grant; never includes failed response bodies or credentials. */
export async function sendFailureAlert(config, fetcher = fetch) {
  const { token, senderId, deskId, runId } = config;
  if (![token, senderId, deskId, runId].every((value) => typeof value === 'string' && value.length))
    throw new Error('Missing alert configuration');
  if (!/^[0-9]+$/.test(runId)) throw new Error('Invalid run ID');
  try {
    const response = await fetcher('https://centralcity.ai/mcp', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'city_send_message',
          arguments: {
            from_agent_id: senderId,
            to_agent_id: deskId,
            context_id: 'production-canary-alerts',
            idempotency_key: `canary-failure-${runId}`,
            text: `Production canary failed. Inspect GitHub Actions run ${runId} in this repository. This alert reports a failed probe, not a confirmed outage.`,
          },
        },
      }),
    });
    if (!response.ok) throw new Error('HTTP');
    const raw = await response.text();
    const rpc = response.headers.get('content-type')?.includes('text/event-stream')
      ? JSON.parse(
          raw
            .split('\n')
            .find(
              (line) =>
                line.startsWith('data:') && (line.includes('"result"') || line.includes('"error"')),
            )
            .slice(5),
        )
      : JSON.parse(raw);
    if (rpc.jsonrpc !== '2.0' || rpc.id !== 1 || rpc.error || rpc.result?.isError || !rpc.result)
      throw new Error('MCP');
    const receipt =
      rpc.result.structuredContent ??
      JSON.parse(rpc.result.content?.find((item) => item.type === 'text')?.text ?? 'null');
    if (
      !receipt?.message?.id ||
      receipt.message.from_agent_id !== senderId ||
      receipt.message.to_agent_id !== deskId
    )
      throw new Error('Missing receipt');
    return { delivered: true };
  } catch {
    throw new Error('Canary alert failed; inspect credential and service availability');
  }
}
