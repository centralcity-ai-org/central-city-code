import type { ReactElement } from 'react';
import { ELRIC_AI_NOTICE } from '../../../shared/elric-copy';

export interface AddElricCardProps {
  onAdd: () => void;
  onDismiss: () => void;
  busy?: boolean;
  error?: string | null;
}

/**
 * Card inviting the room owner to add Elric to the room.
 * Includes EU AI Act Art. 50 disclosure notice.
 * Follows Central City design code: no decoration, clean tokens.
 */
export function AddElricCard({
  onAdd,
  onDismiss,
  busy = false,
  error = null,
}: AddElricCardProps): ReactElement {
  return (
    <div className="rm-elric-card-wrap">
      <div className="rm-elric-card" role="region" aria-label="Add Elric">
        <div className="rm-elric-card-left">
          <span className="rm-elric-card-text">Elric answers you in this room.</span>
          <span className="rm-elric-card-disclosure">{ELRIC_AI_NOTICE}</span>
        </div>
        <div className="rm-elric-card-actions">
          <button type="button" className="rm-btn-sm rm-primary" onClick={onAdd} disabled={busy}>
            {busy ? 'Adding…' : 'Add Elric'}
          </button>
          <button type="button" className="rm-btn-sm rm-quiet" onClick={onDismiss} disabled={busy}>
            Not now
          </button>
        </div>
      </div>
      {error ? (
        <p className="rm-error rm-elric-card-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
