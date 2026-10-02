import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Moon, Sun, X } from 'lucide-react';
import { api } from '../api';
import { CityMark, useTheme } from '../brand';
import { ELRIC_AI_TAG, ELRIC_NAME } from '../../shared/elric-copy';
import './dashboard.css';

/**
 * /elric for a signed-out visitor (design mockup v2): Elric's clean chat screen,
 * "What can I help with?", a composer and four everyday suggestions. Typing, sending or a
 * suggestion opens one sheet: "Log in or sign up to talk to Elric" (Continue with Google when the
 * server offers it, then Log in and Sign up for free). Nothing is sent anywhere before sign-in.
 */
const SUGGESTIONS: Array<[string, string]> = [
  ['Invite ChatGPT to a room', 'step by step'],
  ['Summarize my room', 'key points and decisions'],
  ['Plan tasks with my team', 'turn a goal into tasks'],
  ['What is Central City?', 'how rooms and AIs work together'],
];

export type AuthMode = 'signin' | 'register';

function AuthSheet({
  google,
  onAuth,
  onClose,
}: {
  google: boolean;
  onAuth: (mode: AuthMode) => void;
  onClose: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    sheet.current?.querySelector<HTMLElement>('button[data-first]')?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !sheet.current) return;
      // Keep focus inside the sheet.
      const items = Array.from(
        sheet.current.querySelectorAll<HTMLElement>('button, a[href]'),
      ).filter((item) => !item.hasAttribute('disabled'));
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  async function continueWithGoogle() {
    setError('');
    try {
      const { url } = await api<{ url: string }>('/api/auth/google/start', {
        intent: 'signin',
        // Back to the chat after Google (the server allows only known paths: shared/return-path.ts).
        next: '/elric',
      });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in is not available right now.');
    }
  }

  return (
    <div className="elx-scrim elx-auth-scrim" onClick={onClose}>
      <div
        ref={sheet}
        className="elx-sheet elx-auth-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="elx-auth-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="elx-icon elx-sheet-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X size={18} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <span className="elx-sheet-mark" aria-hidden="true">
          <CityMark />
        </span>
        <h2 id="elx-auth-title">Log in or sign up to talk to Elric</h2>
        <p>Sign in to chat with Elric and use your Central City rooms.</p>
        <div className="elx-auth-actions">
          {google ? (
            <button
              type="button"
              className="elx-auth-button elx-auth-google"
              data-first=""
              onClick={() => void continueWithGoogle()}
            >
              Continue with Google
            </button>
          ) : null}
          <button
            type="button"
            className="elx-auth-button elx-auth-primary"
            {...(google ? {} : { 'data-first': '' })}
            onClick={() => onAuth('signin')}
          >
            Log in
          </button>
          <button
            type="button"
            className="elx-auth-button elx-auth-secondary"
            onClick={() => onAuth('register')}
          >
            Sign up for free
          </button>
        </div>
        {error ? (
          <p className="elx-auth-error" role="alert">
            {error}
          </p>
        ) : null}
        <p className="elx-auth-legal">
          By continuing, you agree to Central City’s <a href="/terms">Terms of Service</a> and{' '}
          <a href="/privacy">Privacy Policy</a>.
        </p>
      </div>
    </div>
  );
}

/** Light/dark with a plain moon or sun (the stroked icons, never one that reads as a spinner). */
function ThemeButton() {
  const { isDark, toggleTheme } = useTheme();
  return (
    <button
      type="button"
      className="elx-icon"
      aria-label={isDark ? 'Use light theme' : 'Use dark theme'}
      title={isDark ? 'Light theme' : 'Dark theme'}
      onClick={toggleTheme}
    >
      {isDark ? (
        <Sun size={18} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Moon size={18} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
}

export function ElricSignedOut({ onAuth }: { onAuth: (mode: AuthMode) => void }) {
  const [sheet, setSheet] = useState(false);
  const [draft, setDraft] = useState('');
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    let live = true;
    // Continue with Google only when the server has it on (like the sign-in page).
    void api<{ enabled?: boolean }>('/api/auth/google', undefined, 'GET')
      .then((value) => live && setGoogle(value.enabled === true))
      .catch(() => live && setGoogle(false));
    return () => {
      live = false;
    };
  }, []);
  const open = () => setSheet(true);

  return (
    <div className="elx elx-out">
      <header className="elx-header elx-out-header">
        <a className="elx-home" href="/" aria-label="Central City home">
          <CityMark small />
        </a>
        <div className="elx-title">
          <h1 className="elx-out-brand">{ELRIC_NAME}</h1>
          <span className="elx-tag">{ELRIC_AI_TAG}</span>
        </div>
        <div className="elx-actions">
          <button type="button" className="elx-link-button" onClick={() => onAuth('signin')}>
            Log in
          </button>
          <button type="button" className="elx-pill" onClick={() => onAuth('register')}>
            Sign up for free
          </button>
          <ThemeButton />
        </div>
      </header>

      <main className="elx-out-main">
        <div className="elx-out-hero">
          <span className="elx-sheet-mark" aria-hidden="true">
            <CityMark />
          </span>
          <h2>What can I help with?</h2>
          <form
            className="elx-composer elx-out-composer"
            onSubmit={(event) => {
              event.preventDefault();
              open();
            }}
          >
            <textarea
              rows={2}
              value={draft}
              placeholder="Message Elric"
              aria-label="Message Elric"
              onChange={(event) => {
                setDraft(event.target.value);
                if (event.target.value.trim()) open();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  open();
                }
              }}
            />
            <button type="submit" className="elx-send" aria-label="Send">
              <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          </form>
          <p className="elx-meta elx-out-note">
            Elric can make mistakes. Check important information.
          </p>
          <div className="elx-out-cards">
            {SUGGESTIONS.map(([title, line]) => (
              <button key={title} type="button" className="elx-out-card" onClick={open}>
                <span>{title}</span>
                <span className="elx-meta">{line}</span>
              </button>
            ))}
          </div>
        </div>
      </main>

      {sheet ? <AuthSheet google={google} onAuth={onAuth} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
