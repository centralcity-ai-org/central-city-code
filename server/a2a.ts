import { createHash } from 'node:crypto';
import { A2AMappingError } from '../protocol/a2a.js';

export const A2A_AUTH_EXTENSION = 'urn:central-city:a2a:native-auth:1';
const digest = (parts: string[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

// The native job record durably stores this namespace and the full parameters hash.
export function a2aMessageKey(requesterId: string, providerId: string, messageId: string) {
  return `a2a:${digest([requesterId, providerId, messageId])}`;
}
export function a2aTaskIds(requesterId: string, providerId: string, jobId: string) {
  return {
    taskId: `task:${digest([requesterId, providerId, jobId, 'task'])}`,
    contextId: `context:${digest([requesterId, providerId, jobId, 'context'])}`,
  };
}
export class A2ATransportError extends Error {
  constructor(
    public readonly rpcCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function a2aErrorResponse(error: unknown, body: unknown) {
  const request = body as { id?: unknown } | undefined;
  const id =
    request &&
    ((typeof request.id === 'string' && request.id.length <= 128) ||
      (typeof request.id === 'number' && Number.isSafeInteger(request.id)))
      ? request.id
      : null;
  let code = -32603;
  let message = 'The operation could not be completed.';
  let status = 500;
  if (error instanceof A2ATransportError) {
    code = error.rpcCode;
    message = error.message;
    status = 200;
  } else if (error instanceof A2AMappingError) {
    code = {
      UNSUPPORTED_VERSION: -32009,
      UNSUPPORTED_BINDING: -32004,
      PAYLOAD_TOO_LARGE: -32602,
      INVALID_JSON: -32700,
      INVALID_REQUEST: -32600,
      UNSUPPORTED_OPERATION: -32004,
      UNSUPPORTED_PARAMETERS: -32602,
      INVALID_NATIVE_JOB: -32603,
      CANCEL_NOT_CONFIRMED: -32002,
    }[error.code];
    message = error.message;
    status = code === -32603 ? 500 : 200;
  } else if (error instanceof Error) {
    const candidate = (error as Error & { statusCode?: number }).statusCode;
    if (candidate && candidate >= 400 && candidate < 500) {
      status = candidate;
      code =
        candidate === 404
          ? -32001
          : candidate === 400
            ? error.message === 'Invalid JSON'
              ? -32700
              : -32600
            : -32000;
      message = error.message;
    }
  }
  return { status, body: { jsonrpc: '2.0' as const, id, error: { code, message } } };
}
