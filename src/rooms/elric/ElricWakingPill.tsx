import type { ReactElement } from 'react';

/**
 * Pulse pill shown while waiting for Elric invocation after @Elric mention.
 */
export function ElricWakingPill(): ReactElement {
  return (
    <div className="rm-waking-pill" role="status" aria-live="polite">
      <span className="rm-pulse-dot" aria-hidden="true" />
      <span>Elric is waking up…</span>
    </div>
  );
}
