import type { Database } from '../../database.js';
import { loadRoomReposConfig, roomReposEnabled, type RoomReposConfig } from './config.js';
import { createGitHubApp, fetchTransport, type GitHubApp, type GitHubTransport } from './github.js';
import { createRoomRepos, type RoomRepos } from './service.js';

export { registerRoomCodeMigration, ROOM_CODE_TABLES } from './schema.js';
export { roomReposEnabled } from './config.js';
export type { RoomRepos } from './service.js';

/**
 * Builds the room repos service from the environment (docs/ROOM_REPOS.md "Configuration").
 *
 * - The environment is read only when `CITY_ROOM_REPOS=1`; otherwise the App is never loaded.
 * - Without an App id and key the service answers `503 repos_not_configured`.
 * - A malformed id, key or allowlist never stops the server: the service answers
 *   `503 repos_not_configured` and the startup error (which contains no key material) is
 *   reported through `onConfigError`.
 */
export function createRoomReposFromEnv(options: {
  db: Database;
  clock(): number;
  limit(key: string, max: number, windowMs: number): Promise<void>;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  transport?: GitHubTransport;
  onConfigError?: (message: string) => void;
}): RoomRepos {
  const env = options.env ?? process.env;
  let config: RoomReposConfig | null = null;
  let github: GitHubApp | null = null;
  if (roomReposEnabled(env)) {
    try {
      config = loadRoomReposConfig(env);
      github = config
        ? createGitHubApp(config, options.transport ?? fetchTransport, options.clock)
        : null;
    } catch (error) {
      config = null;
      github = null;
      options.onConfigError?.((error as Error).message);
    }
  }
  return createRoomRepos({
    db: options.db,
    clock: options.clock,
    limit: options.limit,
    github,
    installationOwners: github && config ? config.installationOwners : new Map(),
  });
}
