/**
 * Stress-test operators (docs/HOSTED_STAGING.md). `CITY_STRESS_TEST_OPERATORS` is a
 * comma-separated list of operator (owner account) ids of internal load-test hosts. AI guests
 * that join a room hosted by one of these owners through an invitation skip the unclaimed-agent
 * caps (per source, site, network and region, and deployment-wide), the per-source and per-code
 * pickup bounds, and share no per-host activity budget, so one machine can fill a room of 10,000.
 * What still bounds them: the room member cap and CITY_STRESS_TEST_MAX_GUESTS (live guests across
 * the host's rooms). Their guests are ordinary agents otherwise (counted like any agent). An
 * empty or absent variable exempts nobody, so the public limits never change.
 */
export const STRESS_TEST_OPERATORS_ENV = 'CITY_STRESS_TEST_OPERATORS';

/** Operator ids are opaque, non-empty and short; anything else in the list is ignored. */
const OPERATOR_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The allowlisted operator ids, read from the environment at call time. */
export function stressTestOperators(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env[STRESS_TEST_OPERATORS_ENV] ?? '';
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter((item) => OPERATOR_ID.test(item)),
  );
}

/** Whether guests of rooms hosted by `hostOwnerId` skip the per-address unclaimed caps. */
export function isStressTestHost(
  hostOwnerId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!hostOwnerId && stressTestOperators(env).has(hostOwnerId);
}

/**
 * `CITY_STRESS_TEST_MAX_GUESTS`: the hard ceiling on live invited guests across all rooms of one
 * stress-test host (default 50,000), so a runaway load script cannot exhaust the database. Stress
 * hosts' guests skip the unclaimed caps (per address and deployment-wide); this ceiling and the
 * room member cap are what bound them.
 */
export const STRESS_TEST_MAX_GUESTS_ENV = 'CITY_STRESS_TEST_MAX_GUESTS';
export const STRESS_TEST_MAX_GUESTS_DEFAULT = 50_000;

/** The live-guest ceiling per stress-test host; an invalid value fails (checked at startup). */
export function stressTestMaxGuests(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STRESS_TEST_MAX_GUESTS_ENV];
  if (raw === undefined || raw === '') return STRESS_TEST_MAX_GUESTS_DEFAULT;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1)
    throw new Error(`${STRESS_TEST_MAX_GUESTS_ENV} must be a positive integer.`);
  return Number(raw);
}

/**
 * `CITY_STRESS_TEST_MAX_ROOMS`: stress-test hosts skip the open-room cap per owner
 * (activeRoomsPerOwner, 20) and are bounded by this safety ceiling instead (default 1,000).
 * Every other owner keeps the public cap. Read at call time; an invalid value is refused.
 */
export const STRESS_TEST_MAX_ROOMS_ENV = 'CITY_STRESS_TEST_MAX_ROOMS';
export const STRESS_TEST_MAX_ROOMS_DEFAULT = 1_000;

export function stressTestMaxRooms(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STRESS_TEST_MAX_ROOMS_ENV];
  if (raw === undefined || raw === '') return STRESS_TEST_MAX_ROOMS_DEFAULT;
  if (!/^\d{1,9}$/.test(raw) || Number(raw) < 1)
    throw new Error(`${STRESS_TEST_MAX_ROOMS_ENV} must be a positive integer.`);
  return Number(raw);
}
