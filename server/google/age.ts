import { GOOGLE_LIMITS, type GoogleTransport } from './config.js';

/**
 * Reading the Google birthday for Elric's 18+ age confirmation (docs/GOOGLE_SIGNIN.md "Age
 * confirmation"), only when CITY_GOOGLE_BIRTHDAY_SCOPE=1 (off at launch: the owner enters the
 * date of birth). The Google birthday is self-declared, so this confirms the age the account
 * states; it is not an identity or age verification. At a link, the server reads it once,
 * server-side, with the access token from the code exchange (People API
 * `people/me?personFields=birthdays`) and drops the token; the date goes only to pii.ts
 * (encrypted). Never logged or returned.
 *
 * - The account birthday (`metadata.source.type` ACCOUNT, the one Google's own age rules use) is
 *   preferred; other sources (the profile, contacts) count only when there is no ACCOUNT entry.
 * - Only a full date (year, month and day) counts; a missing part, a hidden birthday, dates that
 *   disagree, an impossible or future date, or any People API failure is unknown (fail closed).
 * - Someone turns 18 at the start of their 18th birthday (UTC); a 29 February birthday counts
 *   from 1 March in common years.
 */
export const BIRTHDAY_SCOPE = 'https://www.googleapis.com/auth/user.birthday.read';
export const PEOPLE_BIRTHDAYS_URL =
  'https://people.googleapis.com/v1/people/me?personFields=birthdays';

export type AgeCheck = 'over_18' | 'under_18' | 'unknown';

interface FullDate {
  year: number;
  month: number;
  day: number;
}

function fullDate(value: unknown): FullDate | null {
  if (!value || typeof value !== 'object') return null;
  const { year, month, day } = value as Record<string, unknown>;
  if (![year, month, day].every((part) => Number.isInteger(part))) return null;
  const date = { year: year as number, month: month as number, day: day as number };
  if (date.year < 1900 || date.month < 1 || date.month > 12 || date.day < 1) return null;
  const daysInMonth = new Date(Date.UTC(date.year, date.month, 0)).getUTCDate();
  return date.day <= daysInMonth ? date : null;
}

/** Whole years from `birth` to the UTC date of `now`; negative for a future date. */
export function ageInYears(birth: FullDate, now: number): number {
  const today = new Date(now);
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth() + 1;
  const day = today.getUTCDate();
  const before = month < birth.month || (month === birth.month && day < birth.day);
  return year - birth.year - (before ? 1 : 0);
}

/**
 * The birthday from a People API `people/me?personFields=birthdays` body: the ACCOUNT entry when
 * there is one, else the others; only a full, consistent, plausible date. Else null.
 */
export function birthdayFromPeople(body: unknown, now: number): FullDate | null {
  const birthdays = (body as { birthdays?: unknown } | null)?.birthdays;
  if (!Array.isArray(birthdays)) return null;
  const isAccount = (entry: unknown) =>
    (entry as { metadata?: { source?: { type?: unknown } } } | null)?.metadata?.source?.type ===
    'ACCOUNT';
  const account = birthdays.filter(isAccount);
  const dates = (account.length ? account : birthdays)
    .map((entry) => fullDate((entry as { date?: unknown } | null)?.date))
    .filter((date): date is FullDate => date !== null);
  if (!dates.length) return null;
  const [first] = dates;
  if (
    dates.some(
      (date) => date.year !== first!.year || date.month !== first!.month || date.day !== first!.day,
    )
  )
    return null;
  const age = ageInYears(first!, now);
  return age < 0 || age > 150 ? null : first!;
}

/** The age check from a People API body (see birthdayFromPeople). */
export function ageCheckFromBirthdays(body: unknown, now: number): AgeCheck {
  const birthday = birthdayFromPeople(body, now);
  if (!birthday) return 'unknown';
  return ageInYears(birthday, now) >= 18 ? 'over_18' : 'under_18';
}

/** 'YYYY-MM-DD' of a full date. */
export function isoDate(date: FullDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

/**
 * Reads the birthday with `accessToken` (used once, here only). Returns the full date, or null
 * when it is unknown (fail closed).
 */
export async function readGoogleBirthday(
  transport: GoogleTransport,
  accessToken: unknown,
  now: number,
): Promise<string | null> {
  if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 4096) return null;
  try {
    const response = await transport({
      method: 'GET',
      url: PEOPLE_BIRTHDAYS_URL,
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    });
    if (response.status !== 200 || response.body.length > GOOGLE_LIMITS.responseBytes) return null;
    const birthday = birthdayFromPeople(JSON.parse(response.body), now);
    return birthday ? isoDate(birthday) : null;
  } catch {
    return null;
  }
}

/** The age check read from Google (tests and callers that need only the result). */
export async function checkGoogleAge(
  transport: GoogleTransport,
  accessToken: unknown,
  now: number,
): Promise<AgeCheck> {
  const date = await readGoogleBirthday(transport, accessToken, now);
  if (!date) return 'unknown';
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  return ageInYears({ year, month, day }, now) >= 18 ? 'over_18' : 'under_18';
}
