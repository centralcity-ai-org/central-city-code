import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  LayoutGrid,
  LayoutList,
  LoaderCircle,
  LogIn,
  Menu,
  Moon,
  PanelLeft,
  Plus,
  Sun,
  X,
  LogOut,
  UserRound,
} from 'lucide-react';
import { withRoomDeadline, type Agent, type Room, type RoomsClient } from './api';
import { JoinRoomSheet } from './JoinRoomSheet';
import { JoinScreen } from './JoinScreen';
import { roomSlugOf } from './pendingJoin';
import { RoomView } from './RoomView';
import { describe } from './useRoomThread';
import { navigate } from '../shell/navigation';
import { useTheme } from '../shell/theme';
import './rooms.css';
import './sidebar.css';

const LIST_POLL_MS = 10_000;
/** Under this width the sidebar is an off-canvas drawer (matches sidebar.css). */
const PHONE_QUERY = '(max-width: 899px)';

/** Typing in a field, a select or an editable region: global shortcuts stay out of the way. */
function isEditable(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

/**
 * The account card at the bottom of the sidebar. Signed in, it opens a small menu with the
 * Sign out (Workspace, at the top of the sidebar, leads to the main overview).
 */
function ProfileMenu({ name, signedIn }: { name: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);
  if (!signedIn)
    return (
      <div className="rm-sidebar-profile-card">
        <span className="rm-profile-card-name profile-card-name">{name}</span>
      </div>
    );
  const signOut = async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-City-Request': '1' },
        body: '{}',
      });
      // Cached conversations stay on this device otherwise.
      await import('../Messages').then((module) => module.forgetMessagesState()).catch(() => {});
    } finally {
      window.location.assign('/');
    }
  };
  return (
    <div className="rm-profile-menu" ref={root}>
      {open ? (
        <div className="rm-profile-menu-list" role="menu" aria-label="Account">
          <button
            type="button"
            role="menuitem"
            className="rm-profile-menu-item"
            disabled={busy}
            onClick={() => void signOut()}
          >
            <LogOut size={15} aria-hidden="true" />
            Sign out
          </button>
        </div>
      ) : null}
      <button
        ref={button}
        type="button"
        className="rm-sidebar-profile-card rm-profile-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={name}
        title={name}
        onClick={() => setOpen((value) => !value)}
      >
        {/* The collapsed rail shows only this icon; the card shows the name and a menu chevron. */}
        <UserRound className="rm-profile-rail-icon" size={18} aria-hidden="true" />
        <span className="rm-profile-card-name profile-card-name">{name}</span>
        <ChevronUp className="rm-profile-chevron" size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/** The name shown in the sidebar footer: the account name, never a placeholder person. */
function displayNameOf(accountName: string) {
  const name = accountName.trim();
  if (!name) return 'Account';
  return name.includes('@') ? name.slice(0, name.indexOf('@')) || 'Account' : name;
}
const ROOM_PATH = /^\/rooms\/([A-Za-z0-9_-]{1,64})\/?$/;

type View = { kind: 'rooms'; id: string | null } | { kind: 'join'; slug: string };
function viewOf(pathname: string): View {
  const slug = roomSlugOf(pathname);
  if (slug) return { kind: 'join', slug };
  return { kind: 'rooms', id: ROOM_PATH.exec(pathname)?.[1] ?? null };
}

/** Last-read seq per room: a per-device convenience. */
const readKey = (workspace: string) => `cc.rooms.read.${workspace}`;
function readMarks(workspace: string): Record<string, number> {
  try {
    return JSON.parse(window.localStorage.getItem(readKey(workspace)) ?? '{}') as Record<
      string,
      number
    >;
  } catch {
    return {};
  }
}
function writeMarks(workspace: string, marks: Record<string, number>) {
  try {
    window.localStorage.setItem(readKey(workspace), JSON.stringify(marks));
  } catch {
    // Storage unavailable: unread counts reset on reload.
  }
}

function NewRoomDialog({
  client,
  onCreated,
  onClose,
}: {
  client: RoomsClient;
  onCreated: (room: Room) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [agentId, setAgentId] = useState('');
  const [agentName, setAgentName] = useState('');
  const [name, setName] = useState('');
  // Default on: an AI invited later reads the conversation instead of asking for it again.
  const [full, setFull] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const created = useRef<Agent | null>(null);
  useEffect(() => {
    withRoomDeadline(client.listAgents())
      .then((list) => {
        setAgents(list);
        setAgentId(list[0]?.id ?? '');
      })
      .catch((err) => setError(describe(err)));
  }, [client]);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      let host = agentId;
      if (!host) {
        // No agent yet: create one to host (kept across a retry of the room creation).
        created.current ??= await withRoomDeadline(client.createAgent({ name: agentName.trim() }));
        host = created.current.id;
      }
      const room = await withRoomDeadline(
        client.create({
          agent_id: host,
          name: name.trim(),
          idempotency_key: key.current,
          history: full ? 'full' : 'from_join',
        }),
      );
      onCreated(room);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="rm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="rm-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-new-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <div className="rm-sheet-head">
          <h2 id="rm-new-title">New room</h2>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <label className="rm-field">
          <span>Room name</span>
          <input
            className="rm-input"
            autoFocus
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
              key.current = crypto.randomUUID();
            }}
          />
        </label>
        {agents === null ? null : agents.length ? (
          <label className="rm-field">
            <span>Host agent</span>
            <select
              className="rm-input"
              value={agentId}
              onChange={(event) => {
                setAgentId(event.target.value);
                key.current = crypto.randomUUID();
              }}
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="rm-field">
            <span>Your agent's name (it hosts the room)</span>
            <input
              className="rm-input"
              value={agentName}
              maxLength={64}
              onChange={(event) => setAgentName(event.target.value)}
            />
          </label>
        )}
        <label className="rm-check">
          <input
            type="checkbox"
            checked={full}
            onChange={(event) => {
              setFull(event.target.checked);
              key.current = crypto.randomUUID();
            }}
          />
          <span>New members can read earlier messages</span>
        </label>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          className="rm-primary"
          disabled={
            busy || !name.trim() || agents === null || (!agents.length && !agentName.trim())
          }
        >
          {busy ? 'Creating…' : 'Create room'}
        </button>
      </form>
    </div>
  );
}

/**
 * The Rooms experience: a sidebar of your rooms and the open room as a chat, plus the join flow
 * on /r/<slug>. Mount it for /rooms, /rooms/:id and /r/:slug, after capturePendingJoin() has
 * run (see docs/ROOMS_UX.md).
 */
export function RoomsApp({
  client,
  signedIn,
  workspaceId,
  accountName,
  onSignIn,
}: {
  client: RoomsClient;
  /** The active workspace: read marks are kept per workspace. Remount RoomsApp when it changes. */
  workspaceId: string;
  signedIn: boolean;
  /** Prefills the new agent name on the join screen ("{name}'s agent"). */
  accountName: string;
  /** Start sign-in and come back to `next` (a room path; never carries the invite secret). */
  onSignIn: (next: string) => void;
  /**
   * Accepted for compatibility with the app shell and not rendered: the sidebar footer holds
   * only the theme toggle and the account name.
   */
  nav?: React.ReactNode;
}) {
  const [view, setView] = useState<View>(() => viewOf(window.location.pathname));
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [listError, setListError] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [marks, setMarks] = useState(() => readMarks(workspaceId));
  const drafts = useRef(new Map<string, string>());
  const [, setDraftVersion] = useState(0);

  // Collapsible icon rail on desktop (remembered per device).
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('cc.rooms.sidebar.collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('cc.rooms.sidebar.collapsed', next ? '1' : '0');
      } catch {
        // Storage unavailable
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '\\' && !isEditable(e.target)) {
        e.preventDefault();
        toggleCollapse();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleCollapse]);

  const [closedExpanded, setClosedExpanded] = useState(false);
  const { isDark, toggleTheme } = useTheme();

  // Phone drawer: inert while closed, focus moves in on open and back to the opener on close,
  // Escape closes it and Tab stays inside while it is open.
  const [phone, setPhone] = useState(() => window.matchMedia?.(PHONE_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const change = () => setPhone(query.matches);
    change();
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeDrawerRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const drawerWasOpen = useRef(false);
  const skipFocusReturn = useRef(false);
  // The menu button opens the drawer on a phone; on a wider screen the sidebar is always there,
  // so the same button collapses or expands the rail instead.
  const openDrawer = useCallback(() => {
    if (!phone) {
      toggleCollapse();
      return;
    }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDrawer(true);
  }, [phone, toggleCollapse]);
  useEffect(() => {
    if (!phone) setDrawer(false);
  }, [phone]);
  useEffect(() => {
    if (drawer) {
      drawerWasOpen.current = true;
      closeDrawerRef.current?.focus();
      return;
    }
    if (!drawerWasOpen.current) return;
    drawerWasOpen.current = false;
    const back = opener.current;
    opener.current = null;
    if (skipFocusReturn.current) {
      skipFocusReturn.current = false;
      return;
    }
    // The opener can be gone (a room link swapped the view): use the menu button now shown.
    const target =
      back?.isConnected && back.getClientRects().length
        ? back
        : Array.from(document.querySelectorAll<HTMLElement>('.rm-menu')).find(
            (button) => button.getClientRects().length > 0,
          );
    target?.focus();
  }, [drawer]);
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawer(false);
        return;
      }
      const sidebar = sidebarRef.current;
      if (event.key !== 'Tab' || !sidebar) return;
      const items = Array.from(
        sidebar.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.getClientRects().length > 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && sidebar.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [drawer]);
  // A sheet opened from the drawer takes focus itself; the drawer closes underneath it.
  const openSheet = useCallback(
    (show: (value: boolean) => void) => {
      if (drawer) {
        skipFocusReturn.current = true;
        setDrawer(false);
      }
      show(true);
    },
    [drawer],
  );

  const go = useCallback((path: string, replace = false) => {
    if (replace) window.history.replaceState(null, '', path);
    else window.history.pushState(null, '', path);
    setView(viewOf(path));
    setDrawer(false);
  }, []);
  useEffect(() => {
    const pop = () => setView(viewOf(window.location.pathname));
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  const listRetry = useRef({ timer: 0, failures: 0 });
  const loadRooms = useCallback(async () => {
    window.clearTimeout(listRetry.current.timer);
    try {
      const list = await withRoomDeadline(client.listRooms());
      setRooms(list);
      setListError('');
      listRetry.current.failures = 0;
    } catch (err) {
      setListError(describe(err));
      // A failed read (429, 503, network) retries with backoff, not only on the 10 s poll.
      const delay = Math.min(1000 * 2 ** listRetry.current.failures++, 8000);
      listRetry.current.timer = window.setTimeout(() => void loadRooms(), delay);
    }
  }, [client]);
  useEffect(() => () => window.clearTimeout(listRetry.current.timer), []);
  useEffect(() => {
    if (!signedIn) return;
    void loadRooms();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadRooms();
    }, LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [signedIn, loadRooms]);

  // Unread rooms first, then the newest; closed rooms last.
  const ordered = useMemo(
    () =>
      [...(rooms ?? [])].sort(
        (a, b) =>
          Number(a.closed) - Number(b.closed) ||
          b.latest_seq - (marks[b.id] ?? 0) - (a.latest_seq - (marks[a.id] ?? 0)) ||
          b.created_at.localeCompare(a.created_at),
      ),
    // Order is decided when the list loads, not on every read mark.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rooms],
  );

  const hostingRooms = useMemo(
    () => ordered.filter((room) => room.role === 'host' && !room.closed),
    [ordered],
  );
  const joinedRooms = useMemo(
    () => ordered.filter((room) => room.role !== 'host' && !room.closed),
    [ordered],
  );
  const closedRooms = useMemo(() => ordered.filter((room) => room.closed), [ordered]);

  const onRead = useCallback(
    (roomId: string, seq: number) => {
      setMarks((current) => {
        if ((current[roomId] ?? 0) >= seq) return current;
        const next = { ...current, [roomId]: seq };
        writeMarks(workspaceId, next);
        return next;
      });
    },
    [workspaceId],
  );

  if (view.kind === 'join')
    return (
      <div className="rm-app rm-app-join">
        <JoinScreen
          client={client}
          slug={view.slug}
          signedIn={signedIn}
          accountName={accountName}
          onSignIn={onSignIn}
          onJoined={(room) => {
            void loadRooms();
            go(`/rooms/${room.id}`, true);
          }}
          onRooms={() => go('/rooms', true)}
        />
      </div>
    );
  if (!signedIn)
    return (
      <div className="rm-app rm-app-join">
        <main className="rm-join">
          <h1>Your rooms</h1>
          <button type="button" className="rm-primary" onClick={() => onSignIn('/rooms')}>
            Sign in
          </button>
        </main>
      </div>
    );

  // A room in the address opens at once, without waiting for the rooms list: the thread's own
  // first read supplies its name and state (first paint does not depend on two requests).
  const listed = rooms?.find((room) => room.id === view.id || room.slug === view.id) ?? null;
  const open: Room | null =
    listed ??
    (view.kind === 'rooms' && view.id && rooms === null
      ? {
          id: view.id,
          slug: view.id,
          name: '',
          topic: '',
          role: 'member',
          closed: false,
          readOnly: false,
          history: 'full',
          member_count: 0,
          latest_seq: 0,
          created_at: '',
        }
      : null);

  const unreadOf = (room: Room) => Math.max(0, room.latest_seq - (marks[room.id] ?? 0));
  const openRoom = (event: React.MouseEvent, room: Room) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    go(`/rooms/${room.id}`);
  };

  const isClosedOpen = closedExpanded || Boolean(open?.closed);

  const renderRoomItem = (room: Room) => {
    const unread = unreadOf(room);
    const current = room.id === open?.id;
    return (
      <li key={room.id}>
        <a
          href={`/rooms/${room.id}`}
          aria-current={current ? 'page' : undefined}
          className={`rm-sidebar-room-item rm-room-item${current ? ' active' : ''}${room.closed ? ' closed-item' : ''}${unread && !current ? ' unread' : ''}`}
          title={`${room.name}${room.closed ? ' (Closed)' : ''}`}
          onClick={(event) => openRoom(event, room)}
        >
          <span className={`rm-room-item-dot${room.closed ? ' closed' : ''}`} />
          <span className="rm-room-item-name rm-room-name">{room.name}</span>
          {room.closed ? <span className="rm-meta rm-closed-tag">(closed)</span> : null}
          {unread && !current ? (
            <span className="rm-room-item-badge rm-badge" aria-label={`${unread} unread`}>
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </a>
      </li>
    );
  };

  return (
    <div className="rm-app">
      <nav
        ref={sidebarRef}
        className={`rm-sidebar${drawer ? ' open mobile-open' : ''}${collapsed ? ' collapsed' : ''}`}
        aria-label="Rooms"
        inert={phone && !drawer}
      >
        <div className="rm-sidebar-header">
          <div
            className="rm-sidebar-brand-wrap"
            onClick={() => {
              if (collapsed) toggleCollapse();
            }}
            title="Central City"
            role={collapsed ? 'button' : undefined}
            tabIndex={collapsed ? 0 : undefined}
            aria-label={collapsed ? 'Expand sidebar' : undefined}
            onKeyDown={(e) => {
              if (collapsed && (e.key === 'Enter' || e.key === ' ')) toggleCollapse();
            }}
          >
            <img
              src="/brand/central-city-mark.png"
              alt="Central City"
              className="rm-sidebar-brand-mark"
            />
            <span className="rm-sidebar-brand-text">Central City</span>
          </div>
          <button
            type="button"
            className="rm-sidebar-collapse-btn"
            onClick={toggleCollapse}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeft size={18} aria-hidden="true" />
          </button>
          <button
            ref={closeDrawerRef}
            type="button"
            className="rm-icon rm-close-drawer"
            aria-label="Close rooms"
            onClick={() => setDrawer(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <a
          href="/"
          className="rm-sidebar-nav-action"
          title="Workspace"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
            event.preventDefault();
            setDrawer(false);
            navigate('/');
          }}
        >
          <LayoutGrid size={18} aria-hidden="true" />
          <span>Workspace</span>
        </a>
        <a
          href="/rooms"
          className={`rm-sidebar-nav-action${!open ? ' active' : ''}`}
          title="Room list"
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
            event.preventDefault();
            go('/rooms');
          }}
        >
          <LayoutList size={18} aria-hidden="true" />
          <span>Room list</span>
        </a>

        <div className="rm-sidebar-actions-row">
          <button
            type="button"
            className="rm-sidebar-act-btn primary rm-new"
            onClick={() => openSheet(setCreating)}
            title="New room"
          >
            <Plus size={15} aria-hidden="true" />
            <span>New room</span>
          </button>
          <button
            type="button"
            className="rm-sidebar-act-btn rm-quiet rm-join-room"
            onClick={() => openSheet(setJoining)}
            title="Join a room"
            aria-label="Join a room"
          >
            <LogIn size={15} aria-hidden="true" />
            <span>Join a room</span>
          </button>
        </div>

        <div className="rm-sidebar-rooms-scroll">
          {rooms === null && !listError ? (
            <div className="rm-row-skeletons" role="status" aria-label="Loading rooms">
              {[0, 1, 2, 3, 4].map((index) => (
                <span key={index} />
              ))}
            </div>
          ) : null}
          {listError ? (
            <div className="rm-inline-error" role="alert">
              <span>Rooms couldn't load.</span>
              <button type="button" className="rm-quiet" onClick={() => void loadRooms()}>
                Retry
              </button>
            </div>
          ) : null}
          {rooms && !rooms.length ? <p className="rm-muted rm-no-rooms">No rooms yet</p> : null}

          {hostingRooms.length > 0 ? (
            <div className="rm-sidebar-room-group" id="groupHosting">
              <div className="rm-sidebar-group-header">
                <span>Hosting ({hostingRooms.length})</span>
              </div>
              <ul className="rm-rooms">{hostingRooms.map(renderRoomItem)}</ul>
            </div>
          ) : null}

          {joinedRooms.length > 0 ? (
            <div className="rm-sidebar-room-group" id="groupJoined">
              <div className="rm-sidebar-group-header">
                <span>Joined Rooms ({joinedRooms.length})</span>
              </div>
              <ul className="rm-rooms">{joinedRooms.map(renderRoomItem)}</ul>
            </div>
          ) : null}

          {closedRooms.length > 0 ? (
            <div className="rm-sidebar-room-group" id="groupClosed">
              <button
                type="button"
                className="rm-sidebar-group-header rm-closed-accordion-header"
                onClick={() => setClosedExpanded((prev) => !prev)}
                aria-expanded={isClosedOpen}
                title="Toggle closed rooms"
              >
                <span className="rm-group-header-title">
                  {isClosedOpen ? (
                    <ChevronDown size={12} aria-hidden="true" className="rm-chevron" />
                  ) : (
                    <ChevronRight size={12} aria-hidden="true" className="rm-chevron" />
                  )}
                  <span>Closed Rooms ({closedRooms.length})</span>
                </span>
              </button>
              {isClosedOpen ? (
                <ul className="rm-rooms rm-closed-rooms-list" id="closedRoomsList">
                  {closedRooms.map(renderRoomItem)}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="rm-sidebar-footer">
          <button
            type="button"
            className="rm-sidebar-footer-link"
            data-theme-toggle=""
            onClick={toggleTheme}
            title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={isDark ? 'Light mode' : 'Dark mode'}
          >
            {isDark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
            <span className="theme-label">{isDark ? 'Light mode' : 'Dark mode'}</span>
          </button>

          <ProfileMenu name={displayNameOf(accountName)} signedIn={signedIn} />
        </div>
      </nav>
      {drawer ? <div className="rm-drawer-backdrop" onClick={() => setDrawer(false)} /> : null}
      <div className="rm-main" inert={phone && drawer}>
        {open ? (
          <RoomView
            key={open.id}
            client={client}
            room={open}
            draft={drafts.current.get(open.id) ?? ''}
            onDraft={(text) => {
              drafts.current.set(open.id, text);
              setDraftVersion((value) => value + 1);
            }}
            onOpenMenu={openDrawer}
            onRoomChanged={() => void loadRooms()}
            onRead={onRead}
          />
        ) : rooms === null ? (
          <div className="rm-center" role="status">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          </div>
        ) : (
          <section className="rm-overview" aria-labelledby="rm-overview-title">
            <header className="rm-overview-head">
              {/* Under 900 px the sidebar is a drawer: this button opens it (desktop has none). */}
              <button
                type="button"
                className="rm-icon rm-menu"
                aria-label="Open menu"
                onClick={openDrawer}
              >
                <Menu size={20} aria-hidden="true" />
              </button>
              <h1 id="rm-overview-title">Your rooms</h1>
            </header>
            {rooms.length ? (
              <ul className="rm-overview-list" aria-label="All rooms">
                {ordered.map((room) => {
                  const unread = unreadOf(room);
                  const role = room.closed ? 'Closed' : room.role === 'host' ? 'Hosting' : 'Joined';
                  return (
                    <li key={room.id}>
                      <a
                        href={`/rooms/${room.id}`}
                        className={`rm-overview-room${room.closed ? ' closed' : ''}${unread ? ' unread' : ''}`}
                        onClick={(event) => openRoom(event, room)}
                      >
                        <span
                          className={`rm-room-item-dot${room.closed ? ' closed' : ''}`}
                          aria-hidden="true"
                        />
                        <span className="rm-overview-room-name">{room.name}</span>
                        <span className="rm-overview-room-role">{role}</span>
                        {unread ? (
                          <span className="rm-room-item-badge" aria-label={`${unread} unread`}>
                            {unread > 99 ? '99+' : unread}
                          </span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="rm-overview-empty">
                <h2>No rooms yet</h2>
                <p className="rm-muted">
                  A room is a shared space where AI agents and people meet, work and collaborate.
                  Start one or join with an invite from the sidebar.
                </p>
              </div>
            )}
          </section>
        )}
      </div>
      {joining ? (
        <JoinRoomSheet
          client={client}
          accountName={accountName}
          onClose={() => setJoining(false)}
          onJoined={(room) => {
            setJoining(false);
            setRooms((list) => [room, ...(list ?? []).filter((item) => item.id !== room.id)]);
            go(`/rooms/${room.id}`);
            // The room shows who invited the person and how to bring their own AI.
            window.history.replaceState({ ...(window.history.state ?? {}), joined: true }, '');
          }}
        />
      ) : null}
      {creating ? (
        <NewRoomDialog
          client={client}
          onClose={() => setCreating(false)}
          onCreated={(room) => {
            setCreating(false);
            setRooms((list) => [room, ...(list ?? []).filter((item) => item.id !== room.id)]);
            go(`/rooms/${room.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
