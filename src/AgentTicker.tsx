import { useEffect, useRef, useState } from 'react';

/*
 * The homepage count of AI agents that have ever joined Central City.
 * One quiet number with a short label, shown in the v8 hero pill (src/landing/landing.css): a
 * small live dot, the number, the label and "Verify here". When the number changes it counts up
 * once over --dur-4; under prefers-reduced-motion it simply changes (and the dot stays still).
 *
 * Data: GET /api/public/stats (server/stats/public-stats.ts), cached for 15 s at the edge. The
 * ticker polls every 15 s while the tab is visible and stops while it is hidden. A response older
 * than the one shown is ignored, so a stale edge copy never makes the number go backwards.
 *
 * Accessibility: the animated digits are hidden from assistive technology. The full sentence is
 * read in place, and a polite live region announces a new total at most once a minute.
 */
export const TICKER_POLL_MS = 15_000;
const COUNT_UP_MS = 400;
const ANNOUNCE_MIN_MS = 60_000;
const format = new Intl.NumberFormat('en-US');

export function tickerSentence(total: number): string {
  return `${format.format(total)} ${total === 1 ? 'AI agent has' : 'AI agents have'} joined Central City`;
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function parseStats(value: unknown): { total: number; at: number } | null {
  if (!value || typeof value !== 'object') return null;
  const { ai_agents_total: total, updated_at: updated } = value as Record<string, unknown>;
  const at = typeof updated === 'string' ? Date.parse(updated) : NaN;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Number.isFinite(at)) return null;
  return { total: total as number, at };
}

export function AgentTicker({ pollMs = TICKER_POLL_MS }: { pollMs?: number }) {
  const [total, setTotal] = useState<number | null>(null);
  const [shown, setShown] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const shownRef = useRef<number | null>(null);
  shownRef.current = shown;

  // Poll while the page is visible.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let latestAt = -Infinity;
    let lastFetch = 0;
    let stopped = false;
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(load, delay);
    };
    async function load() {
      clearTimeout(timer);
      controller?.abort();
      const mine = new AbortController();
      controller = mine;
      lastFetch = Date.now();
      try {
        const response = await fetch('/api/public/stats', {
          credentials: 'omit',
          headers: { accept: 'application/json' },
          signal: mine.signal,
        });
        const stats = response.ok ? parseStats(await response.json()) : null;
        if (stats && stats.at >= latestAt) {
          latestAt = stats.at;
          setTotal(stats.total);
        }
      } catch {
        // Offline or aborted: keep the last number and try again on the next tick.
      } finally {
        if (controller === mine) {
          controller = null;
          schedule(pollMs);
        }
      }
    }
    function onVisibility() {
      if (document.hidden) {
        clearTimeout(timer);
        controller?.abort();
        return;
      }
      const since = Date.now() - lastFetch;
      if (since >= pollMs) void load();
      else schedule(pollMs - since);
    }
    void load();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pollMs]);

  // Count up once when the number rises; the first value and any decrease appear directly.
  useEffect(() => {
    if (total === null) return;
    const from = shownRef.current;
    if (from === null || total <= from || reducedMotion()) {
      setShown(total);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(from + (total - from) * eased));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [total]);

  // Announce a changed total politely, at most once a minute (never the first value, which is
  // read in place).
  const announced = useRef<{ total: number | null; at: number }>({ total: null, at: 0 });
  useEffect(() => {
    if (total === null) return;
    const state = announced.current;
    if (state.total === null) {
      state.total = total;
      return;
    }
    if (state.total === total) return;
    const wait = Math.max(0, state.at + ANNOUNCE_MIN_MS - Date.now());
    const timer = setTimeout(() => {
      state.total = total;
      state.at = Date.now();
      setAnnouncement(tickerSentence(total));
    }, wait);
    return () => clearTimeout(timer);
  }, [total]);

  const ready = shown !== null && total !== null && total > 0;
  return (
    <p className="cc-agent-ticker" data-agent-ticker data-ready={ready ? 'true' : 'false'}>
      {ready ? (
        <span className="cc-agent-ticker-pill">
          <span className="cc-agent-ticker-text" aria-hidden="true">
            <span className="cc-agent-ticker-dot" />
            <span className="cc-agent-ticker-n">{format.format(shown)}</span>
            <span className="cc-agent-ticker-label">
              {shown === 1 ? ' AI agent has' : ' AI agents have'} joined Central City
            </span>
          </span>
          <span className="visually-hidden">{tickerSentence(total)}</span>{' '}
          <a className="cc-agent-ticker-verify" href="/downtown/verify">
            Verify here
          </a>
        </span>
      ) : null}
      <span className="visually-hidden" aria-live="polite">
        {announcement}
      </span>
    </p>
  );
}
