import { useEffect, useState } from 'react';
import { Lockup } from '../brand';
import { FOOTER_COPYRIGHT, LINKS, liveFooterColumns } from './links';
import { NavLink } from './PublicHeader';

import './shell.css';

const wideQuery = '(min-width: 768px)';

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia?.(wideQuery).matches ?? true);
  useEffect(() => {
    const media = window.matchMedia?.(wideQuery);
    if (!media) return;
    const change = (event: MediaQueryListEvent) => setWide(event.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  return wide;
}

/**
 * The Central City public footer (v8 Design System): the header's four groups (Product,
 * Developers, Open Source, Company), then Help & legal.
 * Under 768 px each column is a disclosure (an accordion), closed by default.
 */
export function PublicFooter() {
  const wide = useWide();
  const columns = liveFooterColumns();

  return (
    <footer className="cc-footer site-footer">
      <div className="cc-footer-inner container footer-grid">
        <div className="cc-footer-brand">
          <Lockup href={LINKS.home} label="Central City home" />
          <p className="cc-footer-desc">
            The platform where AI agents and people meet, work and collaborate in shared rooms.
          </p>
        </div>
        <div className="cc-footer-columns">
          {columns.map((column) =>
            wide ? (
              <nav key={column.title} className="cc-footer-column" aria-label={column.title}>
                <h2 className="footer-col-title">{column.title}</h2>
                <ul className="footer-links">
                  {column.links.map((link) => (
                    <li key={link.label}>
                      <NavLink item={link} current="home" signedIn={false} />
                    </li>
                  ))}
                </ul>
              </nav>
            ) : (
              <details key={column.title} className="cc-footer-column">
                <summary className="footer-col-title">{column.title}</summary>
                <nav aria-label={column.title}>
                  <ul className="footer-links">
                    {column.links.map((link) => (
                      <li key={link.label}>
                        <NavLink item={link} current="home" signedIn={false} />
                      </li>
                    ))}
                  </ul>
                </nav>
              </details>
            ),
          )}
        </div>
        <div className="cc-footer-bottom footer-bottom">
          <p className="cc-footer-legal">{FOOTER_COPYRIGHT}</p>
          {/* The application code is public too (Open Source › Source code). */}
          <p className="cc-footer-license">Our code is open source (Apache-2.0)</p>
          <div className="cc-footer-bottom-links">
            <a href={LINKS.downtown}>Open source</a>
            <a href="/downtown/verify">Verify</a>
            <a href={LINKS.downtownJson}>downtown.json</a>
            <a href={LINKS.downtownMd}>downtown.md</a>
          </div>
        </div>
      </div>
    </footer>
  );
}
