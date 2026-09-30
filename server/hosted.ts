export interface HostedConfig {
  databaseUrl: string;
  publicOrigin: string;
  allowedOrigins: readonly string[];
  /**
   * Trust exactly one proxy hop for the client address. Only set on Vercel, whose edge
   * overwrites X-Forwarded-For; any other deployment sees the direct socket address.
   */
  trustProxy?: boolean;
}

function httpsOrigin(value: string | undefined): string {
  try {
    const url = new URL(value ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.port ||
      !url.hostname.includes('.') ||
      url.hostname.endsWith('.localhost') ||
      /^[\d.]+$/.test(url.hostname) ||
      url.hostname.includes('*')
    )
      throw new Error();
    if (value !== url.origin && value !== `${url.origin}/`) throw new Error();
    return url.origin;
  } catch {
    throw new Error('Hosted origins must be explicit canonical HTTPS origins.');
  }
}

export function loadHostedConfig(env: NodeJS.ProcessEnv = process.env): HostedConfig {
  if (env.CITY_HOSTED !== '1') throw new Error('Set CITY_HOSTED=1 for hosted staging.');
  let database: URL;
  try {
    database = new URL(env.DATABASE_URL ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      !database.hostname ||
      !database.pathname ||
      database.pathname === '/'
    )
      throw new Error();
  } catch {
    throw new Error('Hosted staging requires a managed PostgreSQL DATABASE_URL.');
  }
  const publicOrigin = httpsOrigin(env.CITY_PUBLIC_ORIGIN);
  const allowedOrigins = [publicOrigin];
  for (const name of [
    'VERCEL_URL',
    'VERCEL_BRANCH_URL',
    'VERCEL_PROJECT_PRODUCTION_URL',
  ] as const) {
    if (env[name]) allowedOrigins.push(httpsOrigin(`https://${env[name]}`));
  }
  return {
    databaseUrl: database.toString(),
    publicOrigin,
    allowedOrigins: [...new Set(allowedOrigins)],
    trustProxy: env.VERCEL === '1',
  };
}

export function checkHostedRequest(
  config: HostedConfig,
  host: string,
  origin: string | undefined,
): boolean {
  const requestOrigin = `https://${host}`;
  return config.allowedOrigins.includes(requestOrigin) && (!origin || origin === requestOrigin);
}
