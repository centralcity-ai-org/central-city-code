export interface CanaryConfig {
  origin: string;
  cookie: string;
  ownerId: string;
  senderId: string;
  recipientId: string;
}
export function runCanary(
  config: CanaryConfig,
  fetcher?: typeof fetch,
): Promise<{ ok: boolean; checks: string[] }>;
