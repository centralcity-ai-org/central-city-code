/**
 * Test helper: a Messages API response object as the event stream the API sends with
 * stream: true (message_start, one start/delta/stop per block, message_delta, message_stop).
 */
export function messageAsEventStream(message: {
  content?: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}): string {
  const { content = [], usage = {}, ...rest } = message;
  const { output_tokens, ...inputUsage } = usage;
  const events: unknown[] = [
    { type: 'message_start', message: { ...rest, content: [], usage: inputUsage } },
  ];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      });
    } else if (block.type === 'thinking') {
      events.push({
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '' },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: block.thinking },
      });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: block.signature },
      });
    } else if (block.type === 'tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      events.push({
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
      });
    } else events.push({ type: 'content_block_start', index, content_block: block });
    events.push({ type: 'content_block_stop', index });
  });
  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens },
  });
  events.push({ type: 'message_stop' });
  return events.map((event) => `event: e\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
