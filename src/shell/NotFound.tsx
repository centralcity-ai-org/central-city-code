import { useEffect } from 'react';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { LINKS } from './links';
import './shell.css';

/** 404. Shown for paths the app does not know. */
export function NotFound() {
  useEffect(() => {
    const previous = document.title;
    document.title = 'Page not found · Central City';
    return () => {
      document.title = previous;
    };
  }, []);
  return (
    <div className="public-shell">
      <PublicHeader current="notfound" />
      <main id="main-content" tabIndex={-1} className="public-main cc-state-page">
        <section className="cc-state" aria-labelledby="not-found-title">
          <h1 id="not-found-title">This page doesn’t exist.</h1>
          <p>The link may be old or mistyped.</p>
          <a className="button primary large" href={LINKS.home}>
            Go home
          </a>
        </section>
      </main>
      <PublicFooter />
    </div>
  );
}
