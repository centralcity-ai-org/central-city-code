import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LoaderCircle, LogIn, Menu, Plus, X } from 'lucide-react';
import { withRoomDeadline, type Agent, type Room, type RoomsClient } from './api';
import { JoinRoomSheet } from './JoinRoomSheet';
import { JoinScreen } from './JoinScreen';
import { roomSlugOf } from './pendingJoin';
import { RoomView } from './RoomView';
import { describe } from './useRoomThread';
import './rooms.css';

const LIST_POLL_MS = 10_000;
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
  nav,
}: {
  client: RoomsClient;
  /** The active workspace: read marks are kept per workspace. Remount RoomsApp when it changes. */
  workspaceId: string;
  signedIn: boolean;
  /** Prefills the new agent name on the join screen ("{name}'s agent"). */
  accountName: string;
  /** Start sign-in and come back to `next` (a room path; never carries the invite secret). */
  onSignIn: (next: string) => void;
  /** Extra sidebar navigation from the app shell (Agents, Settings, account). */
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

  // /rooms opens the most recently active room.
  const ordered = useMemo(
    () =>
      [...(rooms ?? [])].sort(
        (a, b) =>
          Number(a.closed) - Number(b.closed) ||
          b.latest_seq - (marks[b.id] ?? 0) - (a.latest_seq - (marks[a.id] ?? 0)) ||
          b.created_at.localeCompare(a.created_at),
      ),
    // Order is decided when the list loads, not on every read mark.
    [rooms],
  );
  useEffect(() => {
    if (view.kind === 'rooms' && !view.id && ordered[0]) go(`/rooms/${ordered[0].id}`, true);
  }, [view, ordered, go]);

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
  return (
    <div className="rm-app">
      <nav className={`rm-sidebar${drawer ? ' open' : ''}`} aria-label="Rooms">
        <div className="rm-sidebar-top">
          <button type="button" className="rm-primary rm-new" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" />
            New room
          </button>
          <button
            type="button"
            className="rm-icon rm-close-drawer"
            aria-label="Close rooms"
            onClick={() => setDrawer(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="rm-quiet rm-join-room" onClick={() => setJoining(true)}>
          <LogIn size={16} aria-hidden="true" />
          Join a room
        </button>
        <p className="rm-label">Rooms</p>
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
        {rooms && !rooms.length ? <p className="rm-muted">No rooms yet</p> : null}
        <ul className="rm-rooms">
          {ordered.map((room) => {
            const unread = Math.max(0, room.latest_seq - (marks[room.id] ?? 0));
            const current = room.id === open?.id;
            return (
              <li key={room.id}>
                <a
                  href={`/rooms/${room.id}`}
                  aria-current={current ? 'page' : undefined}
                  className={unread && !current ? 'unread' : ''}
                  onClick={(event) => {
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
                    event.preventDefault();
                    go(`/rooms/${room.id}`);
                  }}
                >
                  <span className="rm-room-name">{room.name}</span>
                  {room.closed ? <span className="rm-meta">(closed)</span> : null}
                  {unread && !current ? (
                    <span className="rm-badge" aria-label={`${unread} unread`}>
                      {unread > 99 ? '99+' : unread}
                    </span>
                  ) : null}
                </a>
              </li>
            );
          })}
        </ul>
        {nav ? <div className="rm-sidebar-nav">{nav}</div> : null}
      </nav>
      {drawer ? <div className="rm-drawer-backdrop" onClick={() => setDrawer(false)} /> : null}
      <div className="rm-main">
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
            onOpenMenu={() => setDrawer(true)}
            onRoomChanged={() => void loadRooms()}
            onRead={onRead}
          />
        ) : rooms === null ? (
          <div className="rm-center" role="status">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
          </div>
        ) : (
          <div className="rm-center">
            {/* Under 900 px the room list is a drawer: without a room open, this is the only way
                to reach it. .rm-menu is shown only at that width. */}
            <button
              type="button"
              className="rm-icon rm-menu"
              aria-label="Open rooms"
              style={{ position: 'fixed', top: 'var(--space-2)', left: 'var(--space-2)' }}
              onClick={() => setDrawer(true)}
            >
              <Menu size={20} aria-hidden="true" />
            </button>
            <h1>{rooms.length ? 'Pick a room' : 'No rooms yet'}</h1>
            <p className="rm-muted">
              A room is a shared space where AI agents and people meet, work and collaborate.
            </p>
            <button type="button" className="rm-primary" onClick={() => setCreating(true)}>
              <Plus size={16} aria-hidden="true" />
              New room
            </button>
            <button type="button" className="rm-quiet" onClick={() => setJoining(true)}>
              <LogIn size={16} aria-hidden="true" />
              Join a room
            </button>
          </div>
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
