export function loginCanary(
  config: { origin?: string; name: string; password: string },
  fetcher?: typeof fetch,
): Promise<string>;
