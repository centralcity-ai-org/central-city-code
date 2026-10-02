import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/**
 * A local mock of an OpenAI-compatible model server , on 127.0.0.1 only: no network.
 * Each request to /v1/chat/completions takes the next scripted step (else `fallback`); every
 * request is recorded (method, path, headers, parsed body). Synthetic content only.
 */
export type ModelServerStep =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { raw: string; status?: number; headers?: Record<string, string> }
  /** Answers after `ms` (to hit the client's total timeout). */
  | { delayMs: number; then: ModelServerStep }
  /** A body of `bytes` bytes, streamed without a content-length. */
  | { bigBytes: number }
  /** Closes the connection without answering. */
  | { hangUp: true };

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}

export function chatCompletion(
  message: { content: string | null; tool_calls?: unknown[] },
  usage = { prompt_tokens: 1200, completion_tokens: 80 },
  model = 'served-small',
) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    model,
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
    usage,
  };
}

export async function modelServer(t: { after: (fn: () => Promise<unknown>) => void }) {
  const script: ModelServerStep[] = [];
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  let fallback: ModelServerStep = { json: chatCompletion({ content: 'Hello from the model.' }) };
  let modelsStatus = 200;

  const answer = (res: ServerResponse, step: ModelServerStep) => {
    if ('delayMs' in step) {
      const timer = setTimeout(() => answer(res, step.then), step.delayMs);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if ('hangUp' in step) {
      res.socket?.destroy();
      return;
    }
    if ('bigBytes' in step) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const chunk = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      const pump = () => {
        while (sent < step.bigBytes) {
          sent += chunk.length;
          if (!res.write(chunk)) return res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => {});
      return pump();
    }
    const body = 'json' in step ? JSON.stringify(step.json) : step.raw;
    res.writeHead(step.status ?? 200, { 'content-type': 'application/json', ...step.headers });
    res.end(body);
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      } catch {
        body = null;
      }
      requests.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(modelsStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'served-small' }] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404);
        res.end();
        return;
      }
      answer(res, script.shift() ?? fallback);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  t.after(close);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    chats: () => requests.filter((item) => item.path === '/v1/chat/completions'),
    push(...steps: ModelServerStep[]) {
      script.push(...steps);
    },
    setFallback(step: ModelServerStep) {
      fallback = step;
    },
    setModelsStatus(status: number) {
      modelsStatus = status;
    },
    close,
  };
}

/** A loopback port with nothing listening (connections are refused). */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
