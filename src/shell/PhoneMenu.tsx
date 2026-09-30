import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { NavGroup, NavItem } from './links';

/**
 * The phone menu (under 900 px): a full-screen sheet with the header's four groups as simple
 * expandable sections, then Sign in (or Open app) and the theme. Loaded only when the menu opens,
 * so the first load of a public page stays small.
 */
export default function PhoneMenu({
  id,
  groups,
  renderLink,
  signIn,
  theme,
  chevron,
  onClose,
}: {
  id: string;
  groups: NavGroup[];
  renderLink: (item: NavItem) => ReactNode;
  signIn: ReactNode;
  /** The theme toggle (passed in, so this chunk shares no module with the page). */
  theme: ReactNode;
  /** The sections' chevron icon (from the page, like the theme toggle). */
  chevron: ReactNode;
  /** Closes the menu; after Escape, focus returns to the menu button. */
  onClose: (escape: boolean) => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  // Focus moves into the menu once, when it opens; Escape closes it.
  useEffect(() => {
    sheet.current?.querySelector<HTMLElement>('a, button')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current(true);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return (
    <div
      ref={sheet}
      id={id}
      className="cc-header-menu"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest('a')) onClose(false);
      }}
    >
      <nav aria-label="Menu">
        {groups.map((group) => (
          <MenuGroup key={group.id} group={group} renderLink={renderLink} chevron={chevron} />
        ))}
        {signIn}
      </nav>
      <div className="cc-header-menu-theme">
        <span>Theme</span>
        {theme}
      </div>
    </div>
  );
}

function MenuGroup({
  group,
  renderLink,
  chevron,
}: {
  group: NavGroup;
  chevron: ReactNode;
  renderLink: (item: NavItem) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="cc-menu-group">
      <button
        type="button"
        className="cc-menu-group-button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        {group.label}
        {chevron}
      </button>
      <ul id={panelId} className="cc-menu-group-panel" role="list" hidden={!open}>
        {group.items.map((item) => (
          <li key={item.href}>{renderLink(item)}</li>
        ))}
      </ul>
    </div>
  );
}
