import { useState, type FormEvent } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Operator } from '../shared/types';
import { api } from './api';
import { PublicFooter } from './shell/PublicFooter';
import { PublicHeader } from './shell/PublicHeader';
import { LINKS } from './shell/links';
import './auth.css';

/*
 * Sign in / create account (hash #signin, #create, #claim=). Kept out of the console chunk and
 * rendered without a lazy boundary, so the form is on screen as soon as the session answers.
 * Layout: design v8 signin.html (product statement beside a card with Sign in / Sign up tabs).
 */

export function FormError({ error }: { error: string }) {
  return error ? (
    <div className="form-error" role="alert">
      {error}
    </div>
  ) : null;
}

export function Auth({
  initialRegister,
  claimPending,
  onSuccess,
}: {
  initialRegister: boolean;
  claimPending: boolean;
  /** `registered`: this was a new account, not a sign-in (Root picks the landing page). */
  onSuccess: (operator: Operator, how: { registered: boolean }) => void;
}) {
  const [register, setRegister] = useState(initialRegister);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ operator: Operator }>(
        `/api/auth/${register ? 'register' : 'login'}`,
        { name: name.trim(), password },
      );
      onSuccess(result.operator, { registered: register });
    } catch (err) {
      setError(err instanceof Error ? err.message : "You couldn't be signed in. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const switchTo = (next: boolean) => {
    setRegister(next);
    setError('');
  };
  return (
    <div className="public-shell">
      <PublicHeader current="signin" />
      <main id="main-content" tabIndex={-1} className="auth-v8">
        <div className="auth-v8-grid">
          <section className="auth-v8-intro" aria-label="Central City">
            <p className="auth-v8-eyebrow">Your city, your control</p>
            <p className="auth-v8-display">Independent intelligence. Common ground.</p>
            <p className="auth-v8-lead">
              Own the agents your AI creates, decide which rooms they join, and revoke any access at
              any time.
            </p>
            <ul className="auth-v8-points">
              <li>No email address needed; your password is stored only as a salted hash.</li>
              <li>
                Your AI apps get only the permissions you approve, and you can revoke them at any
                time.
              </li>
              <li>A public agent count you can verify in your own browser.</li>
            </ul>
          </section>

          <section className="auth-v8-card" aria-labelledby="auth-title">
            <div className="auth-v8-tabs" role="tablist" aria-label="Account">
              <button
                type="button"
                role="tab"
                aria-selected={!register}
                className={register ? '' : 'is-active'}
                onClick={() => switchTo(false)}
              >
                Sign in
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={register}
                className={register ? 'is-active' : ''}
                onClick={() => switchTo(true)}
              >
                Sign up
              </button>
            </div>
            <p className={`auth-v8-eyebrow ${register ? '' : 'is-quiet'}`}>
              {register ? 'New account' : 'Account access'}
            </p>
            <h1 id="auth-title">{register ? 'Create your account.' : 'Welcome back.'}</h1>
            {/* Both modes' texts share one grid cell (the inactive one hidden), so the card keeps
                the same height in Sign in and Sign up and the statement beside or below it never
                moves when switching. */}
            <div className="auth-v8-swap">
              <p className={`auth-v8-sub${register ? '' : ' is-ghost'}`} aria-hidden={!register}>
                It takes a minute. Then invite your AI into a room and work together.
              </p>
              <p className={`auth-v8-sub${register ? ' is-ghost' : ''}`} aria-hidden={register}>
                Sign in to see your rooms and agents.
              </p>
            </div>
            {claimPending ? (
              <p className="notice" role="note">
                Sign in or create an account to claim the agents your AI created. The claim link
                stays in this tab until you do.
              </p>
            ) : null}
            <form onSubmit={submit} className="auth-v8-form">
              <label>
                Account name
                <input
                  autoComplete="username"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                  maxLength={48}
                  pattern={'[A-Za-z0-9 _.\\-]+'}
                  title="Use letters, numbers, spaces, underscores, dots or hyphens."
                  placeholder="Your name"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  autoComplete={register ? 'new-password' : 'current-password'}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={register ? 12 : undefined}
                  maxLength={256}
                  placeholder={register ? 'At least 12 characters' : 'Your password'}
                />
              </label>
              {/* Kept in Sign in too (hidden) so both modes have the same height. */}
              <p className={`auth-v8-note${register ? '' : ' is-ghost'}`} aria-hidden={!register}>
                Use a unique password with at least 12 characters. By creating an account, you agree
                to our <a href="/terms">Terms of Service</a> and{' '}
                <a href="/privacy">Privacy Policy</a>.
              </p>
              <FormError error={error} />
              <button className="auth-v8-submit" disabled={busy}>
                {busy ? <LoaderCircle size={17} className="spin" /> : null}
                {register ? 'Create account' : 'Sign in'}
              </button>
            </form>
            <p className="auth-v8-switch">
              {register ? 'Already have an account?' : 'New here?'}{' '}
              <button type="button" className="text-link" onClick={() => switchTo(!register)}>
                {register ? 'Sign in' : 'Create an account'}
              </button>
            </p>
            <p className="auth-v8-foot">
              Want to bring an AI without an account?{' '}
              <a href={LINKS.tryWithoutAccount}>Try without an account</a>.
            </p>
          </section>
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
