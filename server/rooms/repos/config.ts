/**
 * Room repos configuration (docs/ROOM_REPOS.md "Configuration").
 *
 * | Variable | Meaning |
 * |---|---|
 * | `CITY_ROOM_REPOS` | `1` turns the room repo tools on. Anything else: off (the default). |
 * | `CITY_GITHUB_APP_ID` | The GitHub App id (public identifier). |
 * | `CITY_GITHUB_APP_PRIVATE_KEY` | The App private key (PEM). Sensitive; set by the operator only. |
 * | `CITY_GITHUB_INSTALLATION_OWNERS` | `installation_id:owner_id` pairs, comma separated. |
 *
 * The installation allowlist stands in for the GitHub setup-redirect flow until a later version: an
 * installation can be used for binding only by the Central City owner it is mapped to here, so
 * a host can never bind a repo through someone else's installation.
 */
export interface RoomReposConfig {
  appId: string;
  privateKey: string;
  /** installation id → the Central City owner (operator id) allowed to bind through it. */
  installationOwners: Map<number, string>;
}

/** True only when CITY_ROOM_REPOS is 1. */
export function roomReposEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  return env.CITY_ROOM_REPOS === '1';
}

/** Parses `id:owner,id:owner`. Malformed entries are an error, never silently skipped. */
export function parseInstallationOwners(value: string | undefined): Map<number, string> {
  const map = new Map<number, string>();
  if (!value?.trim()) return map;
  for (const raw of value.split(',')) {
    const item = raw.trim();
    if (!item) continue;
    const match = /^([1-9][0-9]{0,15}):([A-Za-z0-9_-]{1,128})$/.exec(item);
    if (!match)
      throw new Error('CITY_GITHUB_INSTALLATION_OWNERS must be installation_id:owner_id pairs.');
    const id = Number(match[1]);
    if (!Number.isSafeInteger(id) || map.has(id))
      throw new Error(
        'CITY_GITHUB_INSTALLATION_OWNERS has an invalid or duplicate installation id.',
      );
    map.set(id, match[2]!);
  }
  return map;
}

/**
 * The configuration, or null when the App is not configured (no id or no key). Enabled but
 * unconfigured deployments answer `503 repos_not_configured` rather than failing to start.
 */
export function loadRoomReposConfig(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): RoomReposConfig | null {
  const appId = env.CITY_GITHUB_APP_ID?.trim();
  const privateKey = env.CITY_GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKey?.trim()) return null;
  if (!/^[1-9][0-9]{0,15}$/.test(appId)) throw new Error('CITY_GITHUB_APP_ID must be a number.');
  return {
    appId,
    privateKey,
    installationOwners: parseInstallationOwners(env.CITY_GITHUB_INSTALLATION_OWNERS),
  };
}
