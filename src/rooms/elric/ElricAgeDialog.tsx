import { useEffect, useRef, type ReactElement } from 'react';
import { X } from 'lucide-react';

export type ElricAgeReason = 'under_18' | 'unknown';

export interface ElricAgeDialogProps {
  reason: ElricAgeReason;
  onClose: () => void;
}

/**
 * Dialog shown when server refuses adding Elric due to age verification.
 * Follows room UI dialog styling (rm-backdrop, rm-sheet, rm-sheet-head, rm-actions).
 */
export function ElricAgeDialog({ reason, onClose }: ElricAgeDialogProps): ReactElement {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href]:not([disabled])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          last.focus();
          e.preventDefault();
        } else if (!e.shiftKey && document.activeElement === last) {
          first.focus();
          e.preventDefault();
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, [onClose]);

  if (reason === 'under_18') {
    return (
      <div className="rm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div
          className="rm-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby="elric-age-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="rm-sheet-head">
            <h2 id="elric-age-title">Elric is for adults</h2>
            <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <p className="rm-instruction">Elric is available from age 18.</p>
          <div className="rm-actions">
            <button type="button" className="rm-primary" onClick={onClose} autoFocus>
              OK
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rm-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="rm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elric-age-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="rm-sheet-head">
          <h2 id="elric-age-title">We couldn't confirm your age</h2>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-instruction">
          Add your birth date to your Google account, then try again.
        </p>
        <div className="rm-actions">
          <a
            href="https://myaccount.google.com/birthday"
            target="_blank"
            rel="noopener noreferrer"
            className="rm-primary"
            style={{ textDecoration: 'none' }}
          >
            Open Google account
          </a>
          <button type="button" className="rm-quiet" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
