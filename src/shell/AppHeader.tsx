import { Menu } from 'lucide-react';
import './shell.css';

/**
 * The signed-in header outside a room: the page title, plus the drawer
 * button under 980 px and the live-update status. Theme, refresh and the account moved to the
 * sidebar's account area (§2.3).
 */
export function AppHeader({
  title,
  live,
  onOpenNavigation,
}: {
  title: string;
  live: boolean;
  onOpenNavigation: () => void;
}) {
  return (
    <header className="topbar cc-app-header">
      <div className="cc-app-header-title">
        <button
          type="button"
          className="icon-button mobile-menu"
          onClick={onOpenNavigation}
          aria-label="Open navigation"
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <p title={title}>{title}</p>
      </div>
      <span className={`connection-indicator ${live ? 'connected' : ''}`}>
        <span aria-hidden="true" />
        {live ? 'Live updates' : 'Updates every few seconds'}
      </span>
    </header>
  );
}
