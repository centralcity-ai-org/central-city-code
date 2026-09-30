import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError } from '../ui/errors';
import { RoomsError, withRoomDeadline, type Room, type RoomMessage, type RoomsClient } from './api';

/** A room opens with its newest page; scrolling up loads older pages of the same size. */
export const PAGE = 50;
/** Poll every 5 s while visible and every 30 s while the tab is hidden. */
const POLL_VISIBLE_MS = 5_000;
const POLL_HIDDEN_MS = 30_000;
/** Bound forward catch-up per poll; a larger backlog restarts at the newest page. */
const CATCH_UP_PAGES = 5;

export function describe(err: unknown): string {
  if (err instanceof RoomsError) {
    if (err.code === 'timeout') return 'This is taking too long. Try again.';
    if (err.code === 'access_denied')
      return "You don't have access to this room. Ask the host for a new link.";
    if (err.code === 'invite_invalid')
      return 'This invite link is invalid or has expired. Ask the host for a new link.';
  }
  const copy = describeError(err, {
    offline: typeof navigator !== 'undefined' && navigator.onLine === false,
  });
  return copy.detail ? `${copy.title} ${copy.detail}` : copy.title;
}

const bySeq = (a: RoomMessage, b: RoomMessage) => a.seq - b.seq;

/**
 * One room's messages by seq (gap-free per room, docs/ROOMS.md): the newest page first, older
 * pages on demand, new messages merged by id. Nothing is cleared except when access is lost, so
 * the list and the composer never remount on a poll.
 */
export function useRoomThread(client: RoomsClient, roomId: string, latestHint: number) {
  const [version, setVersion] = useState(0);
  const [room, setRoom] = useState<Room | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const store = useRef({
    byId: new Map<string, RoomMessage>(),
    from: 0,
    pending: [] as RoomMessage[],
  });
  const hint = useRef(latestHint);
  hint.current = latestHint;
  const actions = useRef({
    refresh: async () => {},
    older: async () => {},
    merge: (_messages: RoomMessage[]) => {},
    trim: (_keep: number) => {},
  });

  useEffect(() => {
    store.current = { byId: new Map(), from: 0, pending: [] };
    setVersion((value) => value + 1);
    setRoom(null);
    setReady(false);
    setError('');
    setDenied(false);
    let active = true;
    let loaded = false;
    let busy = false;
    let chain: Promise<void> = Promise.resolve();
    let timer = 0;
    const bump = () => active && setVersion((value) => value + 1);
    const read = (since: number, limit = PAGE) =>
      withRoomDeadline(client.read({ room_id: roomId, since, limit }));
    const merge = (messages: RoomMessage[]) => {
      for (const message of messages) store.current.byId.set(message.id, message);
    };
    const bounds = () => {
      let oldest = Infinity;
      let newest = 0;
      for (const message of store.current.byId.values()) {
        oldest = Math.min(oldest, message.seq);
        newest = Math.max(newest, message.seq);
      }
      return { oldest, newest };
    };

    const run = (task: () => Promise<void>, queue: boolean) => {
      if (busy && !queue) return chain;
      chain = chain.then(async () => {
        if (!active) return;
        busy = true;
        try {
          await task();
          if (active) {
            setError('');
            setDenied(false);
          }
        } catch (err) {
          if (!active) return;
          if (err instanceof RoomsError && err.code === 'access_denied') {
            store.current = { byId: new Map(), from: 0, pending: [] };
            loaded = false;
            setReady(false);
            setDenied(true);
            bump();
          }
          setError(describe(err));
        } finally {
          busy = false;
        }
      });
      return chain;
    };

    const initial = async () => {
      let page = await read(Math.max(0, hint.current - PAGE));
      // More arrived since the hint: jump straight to the newest page.
      if (page.has_more) page = await read(Math.max(0, page.latest_seq - PAGE));
      if (!active) return;
      store.current.from = page.visible_from_seq;
      merge(page.messages);
      loaded = true;
      setRoom(page.room);
      setReady(true);
      bump();
    };

    const poll = async () => {
      if (!loaded) return initial();
      let since = bounds().newest || store.current.from;
      for (let round = 0; round < CATCH_UP_PAGES; round++) {
        const page = await read(since, 100);
        if (!active) return;
        setRoom(page.room);
        store.current.from = page.visible_from_seq;
        merge(page.messages);
        since = page.next_since;
        if (!page.has_more) break;
      }
      bump();
    };

    // Until the first page has loaded, a failed read (429, 503, network) retries quickly with
    // backoff (1, 2, 4, 5 s…) instead of waiting for the next regular poll.
    let failures = 0;
    const schedule = () => {
      window.clearTimeout(timer);
      const delay = !loaded
        ? Math.min(1000 * 2 ** failures++, 5000)
        : document.visibilityState === 'hidden'
          ? POLL_HIDDEN_MS
          : POLL_VISIBLE_MS;
      timer = window.setTimeout(() => {
        void run(poll, false).finally(() => active && schedule());
      }, delay);
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void run(poll, false);
      schedule();
    };
    actions.current = {
      refresh: () => run(poll, true),
      older: () =>
        loaded
          ? run(async () => {
              const { oldest } = bounds();
              const floor = store.current.from;
              if (!(oldest > floor + 1)) return;
              setLoadingOlder(true);
              try {
                const since = Math.max(floor, oldest - 1 - PAGE);
                const page = await read(since, oldest - 1 - since);
                if (!active) return;
                merge(page.messages);
                bump();
              } finally {
                if (active) setLoadingOlder(false);
              }
            }, false)
          : Promise.resolve(),
      merge: (messages) => {
        merge(messages);
        bump();
      },
      // Keeps the newest `keep`; the older ones page back in (gap-free seq) on scroll-up.
      trim: (keep) => {
        const sorted = [...store.current.byId.values()].sort(bySeq);
        if (sorted.length <= keep) return;
        for (const message of sorted.slice(0, sorted.length - keep))
          store.current.byId.delete(message.id);
        bump();
      },
    };
    void run(initial, true).finally(() => active && schedule());
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('online', visible);
    return () => {
      active = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
    };
  }, [client, roomId]);

  const messages = useMemo(
    () => [...store.current.byId.values()].sort(bySeq),
    // The store is a ref; `version` marks its changes.
    [version],
  );
  const hasOlder = (messages[0]?.seq ?? 0) > store.current.from + 1;
  const refresh = useCallback(() => actions.current.refresh(), []);
  const loadOlder = useCallback(() => actions.current.older(), []);
  const merge = useCallback((items: RoomMessage[]) => actions.current.merge(items), []);
  const trim = useCallback((keep: number) => actions.current.trim(keep), []);
  return {
    trim,
    room,
    messages,
    ready,
    error,
    denied,
    hasOlder,
    loadingOlder,
    refresh,
    loadOlder,
    merge,
  };
}
