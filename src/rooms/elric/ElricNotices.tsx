import type { ReactElement } from 'react';
import { X } from 'lucide-react';
import type { ElricNotice } from '../api';
import { ELRIC_AI_NOTICE } from '../../../shared/elric-copy';

export interface ElricNoticeBannerProps {
  notice: ElricNotice;
  onDismiss: () => void;
}

function formatReset(resetsAt?: string): string {
  if (!resetsAt) return '00:00 UTC';
  try {
    const d = new Date(resetsAt);
    if (isNaN(d.getTime())) return resetsAt;
    const hours = String(d.getUTCHours()).padStart(2, '0');
    const mins = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hours}:${mins} UTC`;
  } catch {
    return '00:00 UTC';
  }
}

/**
 * Ephemeral notice banner (local to viewer session, never posted to the room).
 * Displays limit warning with "Connect your own AI" CTA, or non-owner notice.
 */
export function ElricNoticeBanner({ notice, onDismiss }: ElricNoticeBannerProps): ReactElement {
  if (notice.code === 'elric_limit') {
    return (
      <div className="rm-limit-alert" role="alert">
        <div className="rm-limit-content">
          <svg
            className="rm-limit-icon"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <div className="rm-limit-text">
            <strong>{notice.text}</strong>
            {notice.resets_at ? <span>Resets at {formatReset(notice.resets_at)}.</span> : null}
          </div>
        </div>
        <div className="rm-limit-actions">
          <a href="/connect" className="rm-limit-cta">
            Connect your own AI
          </a>
          <button
            type="button"
            className="rm-notice-dismiss"
            onClick={onDismiss}
            aria-label="Dismiss notice"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rm-ephemeral-notice" role="alert">
      <div className="rm-ephemeral-content">
        <svg
          className="rm-limit-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <span>{notice.text}</span>
      </div>
      <button
        type="button"
        className="rm-notice-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss notice"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * AI Act Article 50 transparency disclosure banner.
 * Rendered once per person per room where Elric is present.
 */
export function ElricAiNoticeBanner({ onDismiss }: { onDismiss: () => void }): ReactElement {
  return (
    <div
      className="rm-ephemeral-notice rm-ai-notice"
      role="region"
      aria-label="AI notice"
      data-testid="elric-ai-notice"
    >
      <div className="rm-ephemeral-content">
        <span className="rm-ai-notice-text">{ELRIC_AI_NOTICE}</span>
      </div>
      <button
        type="button"
        className="rm-notice-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss notice"
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
