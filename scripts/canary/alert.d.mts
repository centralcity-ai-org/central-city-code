export function sendFailureAlert(
  config: { token: string; senderId: string; deskId: string; runId: string },
  fetcher?: typeof fetch,
): Promise<{ delivered: boolean }>;
