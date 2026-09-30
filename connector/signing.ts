import { createHash, createHmac, randomBytes } from 'node:crypto';

/** Native Central City protocol; not an A2A or MCP binding. */
export function signedHeaders(
  token: string,
  method: string,
  pathname: string,
  body = '',
  timestamp = String(Date.now()),
  nonce = randomBytes(18).toString('hex'),
): Record<string, string> {
  const digest = createHash('sha256').update(body, 'utf8').digest('hex');
  const canonical = [method.toUpperCase(), pathname, timestamp, nonce, digest].join('\n');
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-CC-Timestamp': timestamp,
    'X-CC-Nonce': nonce,
    'X-CC-Signature': createHmac('sha256', token).update(canonical, 'utf8').digest('hex'),
  };
}
