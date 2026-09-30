import { Component, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { CityMark } from '../brand';
import './shell.css';

const reloadKey = 'cc.chunkReload';

/**
 * Reloads allowed for chunk failures before the error shows, and the wait before each one.
 * One is not enough right after a deploy: while the production alias moves to the new build,
 * the edge can answer the reloaded page from one build and its chunk from the other, so the
 * first reload can miss too (production logs, 29 Sep 11:29 UTC: four deploys in two minutes).
 */
const RELOAD_DELAYS_MS = [0, 1000, 3000];
/** Reloads older than this belong to an earlier incident, not to this one. */
const RELOAD_WINDOW_MS = 60_000;

/** A failed dynamic import: after a deploy, the old chunk names no longer exist. */
export function isChunkLoadError(error: unknown) {
  const message = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError/i.test(
    message,
  );
}

/**
 * How many chunk reloads this tab made in the current incident (sessionStorage `n@firstAt`).
 * Pure read; null when storage is unavailable (then the page never reloads by itself).
 */
function reloadsSoFar(now = Date.now()): number | null {
  try {
    const [count, first] = (window.sessionStorage.getItem(reloadKey) ?? '').split('@').map(Number);
    if (!count || !first || now - first > RELOAD_WINDOW_MS) return 0;
    return count;
  } catch {
    return null;
  }
}

/** Schedules the next reload; false when the budget is spent or storage is unavailable. */
function reloadAgain() {
  const count = reloadsSoFar();
  if (count === null || count >= RELOAD_DELAYS_MS.length) return false;
  try {
    const first =
      count === 0 ? Date.now() : Number(window.sessionStorage.getItem(reloadKey)?.split('@')[1]);
    window.sessionStorage.setItem(reloadKey, `${count + 1}@${first}`);
  } catch {
    return false;
  }
  window.setTimeout(() => window.location.reload(), RELOAD_DELAYS_MS[count]);
  return true;
}

/** Clears the reload guard once a page has rendered, so a later deploy can reload again. */
export function markRendered() {
  try {
    window.sessionStorage.removeItem(reloadKey);
  } catch {
    // Storage unavailable: the guard simply never set.
  }
}

/**
 * Error boundary. A chunk-load failure reloads the page (up to three times
 * within a minute, guarded in sessionStorage) and keeps the loading state on screen meanwhile;
 * anything else, or a chunk failure after those reloads, shows "Something went wrong" with Retry
 * and the error code and time under Details.
 *
 * Reported: signing in right after a deploy showed "Something went wrong." before
 * the page loaded. The one reload allowed then could land on the old build's chunk again (see
 * RELOAD_DELAYS_MS), and the error page stayed until "Try again" was pressed.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; at: Date | null; reloading: boolean }
> {
  state = { error: null as unknown, at: null as Date | null, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    // Decided before the first fallback render, so the error copy never shows while a reload
    // is still to come (pure: only reads the reload count).
    const count = reloadsSoFar();
    const reloading = isChunkLoadError(error) && count !== null && count < RELOAD_DELAYS_MS.length;
    return { error, at: new Date(), reloading };
  }

  componentDidCatch(error: unknown) {
    if (!isChunkLoadError(error) || !this.state.reloading) return;
    if (!reloadAgain()) this.setState({ reloading: false });
  }

  render() {
    const { error, at, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading)
      return (
        <div className="boot-screen" role="status">
          <CityMark />
          <p className="boot-title">Central City</p>
          <p>
            <LoaderCircle className="spin" size={15} aria-hidden="true" />
            Opening Central City
          </p>
        </div>
      );
    const code = isChunkLoadError(error) ? 'chunk_load_failed' : 'render_failed';
    return (
      <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
        <section className="cc-state" role="alert" aria-labelledby="error-title">
          <h1 id="error-title">Something went wrong.</h1>
          <p>We couldn’t load this page. Try again in a moment.</p>
          <button
            type="button"
            className="button primary large"
            onClick={() => window.location.reload()}
          >
            Try again
          </button>
          <details className="cc-state-details">
            <summary>Details</summary>
            <p>
              <code>{code}</code> · <time dateTime={at?.toISOString()}>{at?.toISOString()}</time>
            </p>
          </details>
        </section>
      </main>
    );
  }
}
