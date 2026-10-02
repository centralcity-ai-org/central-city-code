import { useCallback, useEffect, useRef, useState } from 'react';
import './switch.css';

/**
 * A one-click on/off switch (role="switch"): a native button, so Space and Enter toggle it, with a
 * 44px hit area and a focus ring. `disabledReason` disables it and explains why in a tooltip.
 */
export function Switch({
  checked,
  label,
  onChange,
  busy = false,
  disabledReason,
  showLabel = true,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  busy?: boolean;
  /** When set, the switch is disabled and this is its tooltip. */
  disabledReason?: string | null;
  /** False: the label is for screen readers only (the context names it). */
  showLabel?: boolean;
}) {
  // While a change runs the switch stays focusable (a disabled button would drop keyboard
  // focus); presses meanwhile are queued by useOptimisticSwitch.
  const disabled = Boolean(disabledReason);
  return (
    <button
      type="button"
      role="switch"
      className="cc-switch"
      aria-checked={checked}
      aria-label={showLabel ? undefined : label}
      aria-busy={busy || undefined}
      disabled={disabled}
      title={disabledReason ?? undefined}
      onClick={() => onChange(!checked)}
    >
      {showLabel ? <span className="cc-switch-label">{label}</span> : null}
      <span className="cc-switch-track" aria-hidden="true">
        <span className="cc-switch-thumb" />
      </span>
      {/* The state in words too (not only the colour); aria-checked carries it for readers. */}
      <span className="cc-switch-state" aria-hidden="true">
        {checked ? 'On' : 'Off'}
      </span>
    </button>
  );
}

/**
 * An optimistic switch value: `set` shows the new value at once, runs `commit`, and rolls back
 * with an error toast message when it fails (no toast for an error marked `silent`). A press
 * while a change runs is not lost: the latest wanted value runs right after it (on, off, on
 * always ends on). The shown value follows `value` only when `value` itself changes and no
 * change is running, so a slow refresh never flips the switch back.
 */
export function useOptimisticSwitch(
  value: boolean,
  commit: (next: boolean) => Promise<void>,
  failure: (next: boolean) => string,
) {
  const [shown, setShown] = useState(value);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const running = useRef(false);
  const queued = useRef<boolean | null>(null);
  const latestCommit = useRef(commit);
  latestCommit.current = commit;
  useEffect(() => {
    if (!running.current) setShown(value);
  }, [value]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);
  const set = useCallback(
    async (next: boolean) => {
      setShown(next);
      if (running.current) {
        queued.current = next;
        return;
      }
      running.current = true;
      setBusy(true);
      setToast('');
      let target: boolean | null = next;
      let settled = !next;
      while (target !== null) {
        const want: boolean = target;
        queued.current = null;
        try {
          await latestCommit.current(want);
          settled = want;
        } catch (error) {
          setShown(settled);
          // A `silent` rejection hands over to another flow (a dialog) without an error.
          if (!(error as { silent?: boolean } | null)?.silent) setToast(failure(want));
          queued.current = null;
          break;
        }
        // A press during the change: run it now unless it asks for what is already done.
        target = queued.current !== null && queued.current !== settled ? queued.current : null;
      }
      running.current = false;
      setBusy(false);
    },
    [failure],
  );
  return { shown, busy, toast, set, dismiss: () => setToast('') };
}

/** The error toast for a switch (the global .toast styles). */
export function SwitchToast({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  if (!text) return null;
  return (
    <div className="toast-region" aria-live="assertive" aria-atomic="true">
      <div className="toast" role="alert">
        <span>{text}</span>
        <button type="button" className="cc-switch-toast-close" onClick={onDismiss}>
          OK
        </button>
      </div>
    </div>
  );
}
