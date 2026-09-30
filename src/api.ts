import { plainApiMessage } from './ui/plainText';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    /** The server's machine code (for call sites to branch on; never shown). */
    public code?: string,
    /** Machine-readable facts the server attached (for example a removal's reason). */
    public details?: unknown,
  ) {
    super(message);
  }
}

/**
 * The AI-owned workspace the signed-in person is acting in (docs/AI_WORKSPACES.md), or null for
 * their own. Sent as X-City-Workspace; the server honors it only for workspaces they co-own.
 */
let selectedWorkspace: string | null = null;
export function selectWorkspace(id: string | null): void {
  selectedWorkspace = id;
}
export function selectedWorkspaceId(): string | null {
  return selectedWorkspace;
}

export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  signal?: AbortSignal,
): Promise<T> {
  const workspace: Record<string, string> = selectedWorkspace
    ? { 'X-City-Workspace': selectedWorkspace }
    : {};
  const response = await fetch(path, {
    method: body === undefined && method === 'POST' ? 'GET' : method,
    credentials: 'same-origin',
    headers:
      body === undefined
        ? workspace
        : { 'Content-Type': 'application/json', 'X-City-Request': '1', ...workspace },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });
  const value = (await response.json().catch(() => null)) as {
    error?: string;
    code?: unknown;
    details?: unknown;
  } | null;
  // People see plain sentences, never codes or developer wording (src/ui/plainText.ts).
  if (!response.ok)
    throw new ApiError(
      plainApiMessage(response.status, value),
      response.status,
      typeof value?.code === 'string' ? value.code : undefined,
      value?.details,
    );
  return value as T;
}
