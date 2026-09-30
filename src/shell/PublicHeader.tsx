import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { Lockup, SkipLink } from '../brand';
import { ThemeToggle } from './theme';
import { LINKS } from './links';
import { useInviteHref } from './navigation';
import './shell.css';

export type PublicPage = 'home' | 'connect' | 'signin' | 'downtown' | 'rooms' | 'docs' | 'notfound';

/** The "Developers" section: the public code on GitHub and the protocol district (Docs is in the main nav). */
function developerLinks() {
  if (!LINKS.code) return null;
  return (
    <>
      <a href={LINKS.code} target="_blank" rel="noopener">
        GitHub
        <span className="visually-hidden"> (opens in a new tab)</span>
      </a>
      <a href={LINKS.protocol}>Protocol</a>
    </>
  );
}

/**
 * "Developers" in the wide header: a disclosure button (aria-expanded) that shows a short list
 * of links. Escape closes it and returns focus to the button; a click or focus outside closes
 * it; choosing a link closes it.
 */
function DeveloperMenu() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  return (
    <div className="cc-header-dev" ref={root}>
      <button
        ref={button}
        type="button"
        className="cc-header-dev-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        Developers
      </button>
      <div
        id={panelId}
        className="cc-header-dev-panel"
        hidden={!open}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('a')) setOpen(false);
        }}
      >
        {developerLinks()}
      </div>
    </div>
  );
}

/**
 * The Central City public header (v8 Design System):
 * Existing logo lockup, Downtown, Docs, a "Developers" disclosure (GitHub, Docs,
 * Protocol), quiet "Sign in", primary "Invite your AI", and theme toggle.
 * Under 900 px the nav (with a labelled Developers group), Sign in and theme toggle move into an
 * accessible drawer menu;
 * the primary action and logo stay visible at every viewport.
 */
export function PublicHeader({ current }: { current: PublicPage }) {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // One filled button per view: while a page's own "Invite your AI"
  // (#hero-invite) is on screen, the header's copy of it steps back to secondary style.
  const [heroInviteVisible, setHeroInviteVisible] = useState(false);
  const menuId = useId();
  const menuButton = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const inviteHref = useInviteHref();

  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 4);
    update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, []);

  // Layout effect: decide before the first paint, so the header never flashes filled.
  // Steps back while either the hero button ('Sign up' / 'Invite your AI') or the CTA is visible.
  useLayoutEffect(() => {
    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(
        '#hero-invite, .cc-landing-hero .button.primary, .cc-lp-hero .button.primary',
      ),
    );
    if (targets.length === 0) return;
    const isAnyVisible = () =>
      targets.some((el) => {
        const box = el.getBoundingClientRect();
        return box.bottom > 0 && box.top < window.innerHeight;
      });
    setHeroInviteVisible(isAnyVisible());
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(() => {
      setHeroInviteVisible(isAnyVisible());
    });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    menu.current?.querySelector<HTMLElement>('a, button')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !menuButton.current?.contains(target))
        setMenuOpen(false);
    };
    document.addEventListener('keydown', close);
    document.addEventListener('pointerdown', outside);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('pointerdown', outside);
    };
  }, [menuOpen]);

  const links = (
    <>
      <a
        href={LINKS.downtown}
        className="nav-link"
        aria-current={current === 'downtown' ? 'page' : undefined}
      >
        Downtown
      </a>
      {LINKS.docs ? (
        <a
          href={LINKS.docs}
          className="nav-link"
          aria-current={current === 'docs' ? 'page' : undefined}
        >
          Docs
        </a>
      ) : null}
    </>
  );

  const signIn = (
    <a
      className="cc-header-signin nav-signin"
      href={LINKS.signIn}
      aria-current={current === 'signin' ? 'page' : undefined}
    >
      Sign in
    </a>
  );

  return (
    <header
      className={scrolled || menuOpen ? 'cc-header site-nav is-scrolled' : 'cc-header site-nav'}
    >
      <SkipLink />
      <div className="cc-header-inner nav-inner">
        <Lockup href={LINKS.home} label="Central City home" />
        <nav className="cc-header-nav nav-links" aria-label="Public">
          {links}
          {LINKS.code ? <DeveloperMenu /> : null}
        </nav>
        <div className="cc-header-actions nav-actions">
          <span className="cc-header-wide">{signIn}</span>
          <a
            className={`btn ${heroInviteVisible ? 'btn-secondary secondary' : 'btn-primary primary'} btn-sm button cc-header-invite`}
            href={inviteHref}
            aria-label="Invite your AI"
            aria-current={current === 'connect' ? 'page' : undefined}
          >
            <span className="cc-label-long" aria-hidden="true">
              Invite your AI
            </span>
            <span className="cc-label-short" aria-hidden="true">
              Invite AI
            </span>
          </a>
          <span className="cc-header-wide">
            <ThemeToggle />
          </span>
          <button
            ref={menuButton}
            type="button"
            className="icon-button cc-header-menu-button"
            aria-expanded={menuOpen}
            aria-controls={menuOpen ? menuId : undefined}
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
          </button>
        </div>
      </div>
      {menuOpen ? (
        <div
          ref={menu}
          id={menuId}
          className="cc-header-menu"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a')) setMenuOpen(false);
          }}
        >
          <nav aria-label="Menu">
            {links}
            {LINKS.code ? (
              <div className="cc-header-menu-group" role="group" aria-labelledby={`${menuId}-dev`}>
                <span id={`${menuId}-dev`} className="cc-header-menu-group-title">
                  Developers
                </span>
                {developerLinks()}
              </div>
            ) : null}
            {signIn}
          </nav>
          <div className="cc-header-menu-theme">
            <span>Theme</span>
            <ThemeToggle />
          </div>
        </div>
      ) : null}
    </header>
  );
}
