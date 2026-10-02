import { useEffect, useState } from 'react';
import { ELRIC_AI_TAG, ELRIC_NAME } from '../../shared/elric-copy';
import './thinking.css';

/** When the quiet lines appear while Elric works (the run budget itself is 55 s). */
export const THINKING_SLOW_MS = 10_000;
export const THINKING_SLOWER_MS = 30_000;

/**
 * Elric is working on an answer: three dots in the place where Elric's reply will appear, under
 * "Elric" and the AI tag, from the moment a message is sent until the reply lands. After 10 s a
 * quiet "Thinking…", after 30 s "Still working on it…". Screen readers hear "Elric is thinking"
 * once (aria-live polite); with reduced motion the dots stay still. Shared by the /elric chat and
 * the rooms (src/rooms): one look for Elric everywhere.
 *
 * `since` is when the wait began (ms, Date.now()); a new value restarts the lines.
 */
export function ThinkingDots({ since, className }: { since?: number; className?: string }) {
  const [start] = useState(() => since ?? Date.now());
  const [elapsed, setElapsed] = useState(() => Date.now() - (since ?? start));
  useEffect(() => {
    const begin = since ?? start;
    setElapsed(Date.now() - begin);
    const timer = window.setInterval(() => setElapsed(Date.now() - begin), 1_000);
    return () => window.clearInterval(timer);
  }, [since, start]);
  const line =
    elapsed >= THINKING_SLOWER_MS
      ? 'Still working on it…'
      : elapsed >= THINKING_SLOW_MS
        ? 'Thinking…'
        : null;
  return (
    <div
      className={`cc-thinking ${className ?? ''}`.trim()}
      role="status"
      aria-live="polite"
      data-testid="elric-thinking"
    >
      <p className="cc-thinking-name">
        {ELRIC_NAME} <span className="cc-thinking-tag">{ELRIC_AI_TAG}</span>
      </p>
      <span className="visually-hidden">Elric is thinking</span>
      <span className="cc-thinking-dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      {line ? (
        <span className="cc-thinking-line" aria-hidden="true">
          {line}
        </span>
      ) : null}
    </div>
  );
}
