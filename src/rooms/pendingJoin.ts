/**
 * Join-code capture. `/r/<slug>#<secret>` is read
 * before any render: the secret goes to sessionStorage['cc.pendingJoin'] and the address bar and
 * history entry become `/r/<slug>` at once. From then on the secret is only ever sent in the join
 * request body; it never enters a URL, a query string, `next`, or a log.
 *
 * sessionStorage survives the same tab (including a sign-in round trip) and is lost in a new
 * window or another browser; the person then re-opens the link.
 */
export const PENDING_JOIN_KEY = 'cc.pendingJoin';
const TTL_MS = 30 * 60_000;
const ROOM_PATH = /^\/r\/([A-Za-z0-9_-]{1,64})\/?$/;

export type PendingJoin = { kind: 'room'; slug: string; secret: string; at: number };

/** The slug of a `/r/<slug>` path, or null. */
export function roomSlugOf(pathname: string): string | null {
  return ROOM_PATH.exec(pathname)?.[1] ?? null;
}

/**
 * Call first thing, before rendering or any telemetry. Returns true when a secret was captured.
 * It strips the fragment even when storage fails, so the secret never stays in the address bar.
 */
export function capturePendingJoin(location: Location = window.location): boolean {
  const slug = roomSlugOf(location.pathname);
  const secret = location.hash.slice(1);
  if (!slug || !secret) return false;
  window.history.replaceState(window.history.state, '', `/r/${slug}`);
  // Invite tokens and join codes are base64url; anything else is not stored.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(secret)) return false;
  try {
    const value: PendingJoin = { kind: 'room', slug, secret, at: Date.now() };
    window.sessionStorage.setItem(PENDING_JOIN_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The pending join, whatever its slug, if fresh (30 minutes). */
function freshPendingJoin(now: number): PendingJoin | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_JOIN_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingJoin>;
    // An expired or malformed code is removed as soon as it is found.
    if (
      value.kind !== 'room' ||
      typeof value.slug !== 'string' ||
      typeof value.secret !== 'string' ||
      typeof value.at !== 'number' ||
      now - value.at > TTL_MS
    ) {
      window.sessionStorage.removeItem(PENDING_JOIN_KEY);
      return null;
    }
    return value as PendingJoin;
  } catch {
    return null;
  }
}

/** The pending join for this slug, if fresh (30 minutes). */
export function readPendingJoin(slug: string, now = Date.now()): PendingJoin | null {
  const value = freshPendingJoin(now);
  return value?.slug === slug ? value : null;
}

/** The room path of a fresh pending join (`/r/<slug>`), or null. The secret stays in storage. */
export function pendingJoinPath(now = Date.now()): string | null {
  const slug = freshPendingJoin(now)?.slug;
  return slug && /^[A-Za-z0-9_-]{1,64}$/.test(slug) ? `/r/${slug}` : null;
}

export function clearPendingJoin(): void {
  try {
    window.sessionStorage.removeItem(PENDING_JOIN_KEY);
  } catch {
    // Storage unavailable: nothing was stored.
  }
}

/** A same-origin return path for sign-in: room paths or the Verify page, never a fragment or query. */
export function safeNext(value: string | null | undefined): string {
  return value &&
    /^\/(?:rooms(?:\/[A-Za-z0-9_-]{1,64})?|r\/[A-Za-z0-9_-]{1,64}|downtown\/verify)$/.test(value)
    ? value
    : '/rooms';
}
