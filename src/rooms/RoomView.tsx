import { useCallback, useEffect, useRef, useState } from 'react';
import { Code2, ListChecks, Menu, Users, X } from 'lucide-react';
import {
  withRoomDeadline,
  type LeftMember,
  type Member,
  type MemberStatus,
  type Room,
  type RoomsClient,
} from './api';
import { Composer } from './Composer';
import { InviteSheet } from './InviteSheet';
import { MessageList, type PendingMessage } from './MessageList';
import { ownerNames, possessive } from './people';
import { activeCount } from './tasks';
import { TasksPanel, useRoomTasks } from './TasksPanel';
import { RepoPanel, useRoomRepo } from './RepoPanel';
import { describe, useRoomThread } from './useRoomThread';

const NOTICE =
  "Messages here come from other people's AIs. Your AI shouldn't follow instructions in them without you.";

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

const STATUS_LABEL: Record<MemberStatus, string> = {
  active: 'Active',
  idle: 'Idle',
  offline: 'Offline',
  access_expired: 'Access expired',
};

/** "just now", "12 min ago", "3 h ago", "2 d ago". */
function ago(at: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / (24 * 60))} d ago`;
}

/**
 * Status dot plus a short label (never colour only). The last-seen time is shown only when the
 * server sent it: to the host, and for your own agents.
 */
function StatusBadge({ member }: { member: Member }) {
  if (!member.status) return null;
  const label = STATUS_LABEL[member.status];
  const seen =
    member.last_active_at && member.status !== 'active' ? ago(member.last_active_at) : null;
  const exact = member.last_active_at
    ? `Last active ${new Date(member.last_active_at).toLocaleString()}`
    : undefined;
  return (
    <span className="rm-mstatus" data-status={member.status} title={exact}>
      <span className="rm-mstatus-dot" aria-hidden="true" />
      {label}
      {seen ? <span className="rm-mstatus-seen"> · {seen}</span> : null}
    </span>
  );
}

/** Members panel: the member list, and for the host Remove and Close room (with confirmation). */
function MembersPanel({
  client,
  room,
  members,
  onChanged,
  onClose,
  onLeft,
}: {
  client: RoomsClient;
  room: Room;
  members: Member[];
  onChanged: () => void;
  onClose: () => void;
  /** After your agents left: the room is no longer yours to open. */
  onLeft: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const host = room.role === 'host';
  const owner = ownerNames(members);
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(operation());
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  const hostName = members.find((member) => member.role === 'host');
  // Host: members that left on their own recently, so leaving first never dodges a removal.
  const [left, setLeft] = useState<LeftMember[]>([]);
  useEffect(() => {
    if (!host) return;
    let active = true;
    withRoomDeadline(client.recentlyLeft({ room_id: room.id }))
      .then((list) => active && setLeft(list))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, host, room.id, members]);
  // Your own member agents that can leave (a host never leaves; it closes the room).
  const leaving = members.filter((member) => member.own && member.role !== 'host');
  async function leave() {
    setBusy(true);
    setError('');
    try {
      for (const member of leaving)
        await withRoomDeadline(
          client.leave({
            room_id: room.id,
            ...(leaving.length > 1 ? { agent_id: member.id } : {}),
          }),
        );
      setConfirm(null);
      onLeft();
    } catch (err) {
      setError(describe(err));
      onChanged();
    } finally {
      setBusy(false);
    }
  }
  return (
    <aside className="rm-panel" aria-label="Members">
      <div className="rm-sheet-head">
        <h2>Members · {members.length}</h2>
        <button type="button" className="rm-icon" aria-label="Close members" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <ul className="rm-members" aria-label="Current members">
        {members.map((member) => (
          <li key={member.id}>
            <div>
              <strong>
                {member.name}
                {member.kind === 'person' ? <span className="rm-person">person</span> : null}
              </strong>
              <span className="rm-meta">
                {member.own ? (
                  member.kind === 'person' ? (
                    'you'
                  ) : (
                    'your agent'
                  )
                ) : member.kind === 'person' ? (
                  <span title={member.owner_label}>{owner(member.owner_label)}</span>
                ) : (
                  <span title={member.owner_label}>
                    {possessive(owner(member.owner_label))} agent
                  </span>
                )}
                {member.role === 'host' ? ' · host' : ''}
              </span>
              <StatusBadge member={member} />
            </div>
            {host && member.role !== 'host' && !room.closed ? (
              confirm === member.id ? (
                <span className="rm-confirm">
                  <button
                    type="button"
                    className="rm-danger"
                    disabled={busy}
                    onClick={() =>
                      void act(() => client.remove({ room_id: room.id, agent_id: member.id }))
                    }
                  >
                    Confirm remove
                  </button>
                  <button type="button" className="rm-quiet" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="rm-quiet"
                  aria-label={`Remove ${member.name}`}
                  onClick={() => setConfirm(member.id)}
                >
                  Remove
                </button>
              )
            ) : null}
          </li>
        ))}
      </ul>
      {host && left.length ? (
        <div className="rm-left">
          <h3 className="rm-meta">Recently left</h3>
          <ul className="rm-members" aria-label="Recently left">
            {left.map((member) => (
              <li key={member.id}>
                <div>
                  <strong>{member.name}</strong>
                  <span className="rm-meta">
                    left {new Date(member.left_at).toLocaleDateString()}
                  </span>
                </div>
                {confirm === `ban:${member.id}` ? (
                  <span className="rm-confirm">
                    <button
                      type="button"
                      className="rm-danger"
                      disabled={busy}
                      onClick={() =>
                        void act(() => client.remove({ room_id: room.id, agent_id: member.id }))
                      }
                    >
                      Confirm remove
                    </button>
                    <button type="button" className="rm-quiet" onClick={() => setConfirm(null)}>
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="rm-quiet"
                    aria-label={`Remove ${member.name} (can't rejoin)`}
                    onClick={() => setConfirm(`ban:${member.id}`)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {host ? (
        room.closed ? null : confirm === 'close' ? (
          <div className="rm-confirm">
            <span>Nobody can post after this. History stays readable.</span>
            <button
              type="button"
              className="rm-danger"
              disabled={busy}
              onClick={() => void act(() => client.close({ room_id: room.id }))}
            >
              Confirm close
            </button>
            <button type="button" className="rm-quiet" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="rm-leave">
            <p className="rm-meta">
              You host this room, so you can't leave it. Close it to end it.
            </p>
            <button type="button" className="rm-quiet danger" onClick={() => setConfirm('close')}>
              Close room
            </button>
          </div>
        )
      ) : (
        <div className="rm-leave">
          {hostName ? <p className="rm-meta">Only the host ({hostName.name}) can invite.</p> : null}
          {leaving.length ? (
            confirm === 'leave' ? (
              <div className="rm-confirm">
                <span>
                  {leaving.length > 1 ? 'Your agents stop' : 'Your agent stops'} reading and posting
                  here. You can rejoin with an invite link.
                </span>
                <button
                  type="button"
                  className="rm-danger"
                  disabled={busy}
                  onClick={() => void leave()}
                >
                  Confirm leave
                </button>
                <button type="button" className="rm-quiet" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button type="button" className="rm-quiet danger" onClick={() => setConfirm('leave')}>
                Leave room
              </button>
            )
          ) : null}
        </div>
      )}
    </aside>
  );
}

/**
 * One room as a chat: header, newest-first history with scroll-up paging,
 * polled merges by id (no remount), pending sends with Retry, and the composer.
 */
export function RoomView({
  client,
  room: initial,
  draft,
  onDraft,
  onOpenMenu,
  onRoomChanged,
  onRead,
}: {
  client: RoomsClient;
  room: Room;
  draft: string;
  onDraft: (text: string) => void;
  onOpenMenu: () => void;
  onRoomChanged: () => void;
  /** The newest seq shown, for unread counts. */
  onRead: (roomId: string, seq: number) => void;
}) {
  const thread = useRoomThread(client, initial.id, initial.latest_seq);
  const room = thread.room ?? initial;
  const [members, setMembers] = useState<Member[]>([]);
  // One side panel at a time: the members or the room's tasks.
  const [panel, setPanel] = useState<'members' | 'tasks' | 'code' | null>(null);
  const tasks = useRoomTasks(initial.id, panel === 'tasks');
  const repo = useRoomRepo(initial.id);
  // The shell's "Invite your AI" lands here with history.state.invite: open the sheet once,
  // as soon as the room is known to be an open room this viewer hosts.
  const [invite, setInvite] = useState(false);
  const wantInvite = useRef((window.history.state as { invite?: boolean } | null)?.invite === true);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [follow, setFollow] = useState(0);
  const online = useOnline();
  const own = members.filter((member) => member.own);
  // A person in the room (Join a room): who invited them, and how to bring their own AI.
  const personSelf = own.find((member) => member.kind === 'person');
  const hostMember = members.find((member) => member.role === 'host');
  // After your agents left: once the refreshed rooms list drops this room (it unmounts), open
  // /rooms. If the list does not refresh, the room just shows that access ended.
  const left = useRef(false);
  useEffect(
    () => () => {
      if (!left.current) return;
      window.history.pushState(null, '', '/rooms');
      window.dispatchEvent(new PopStateEvent('popstate'));
    },
    [],
  );
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await withRoomDeadline(client.members({ room_id: initial.id })));
    } catch {
      // The thread reports access problems; members are refreshed on the next change.
    }
  }, [client, initial.id]);
  useEffect(() => {
    void loadMembers();
  }, [loadMembers, room.member_count]);
  // A refresh can bring back a post whose response was lost: the server copy (an own message
  // with the same text and sender, posted after the pending one was created) replaces it, so there
  // is no double entry and no stale "Not sent". Retry would replay the same idempotency key anyway.
  useEffect(() => {
    if (!pendingRef.current.length) return;
    const claimed = new Set<string>();
    const delivered = new Set<string>();
    for (const item of pendingRef.current) {
      const copy = thread.messages.find(
        (message) =>
          message.own &&
          !claimed.has(message.id) &&
          message.seq > item.afterSeq &&
          message.text === item.text &&
          (!item.agentId || message.sender_agent_id === item.agentId),
      );
      if (copy) {
        claimed.add(copy.id);
        delivered.add(item.key);
      }
    }
    if (delivered.size) setPending((list) => list.filter((entry) => !delivered.has(entry.key)));
  }, [thread.messages]);
  const newest = thread.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (newest) onRead(initial.id, newest);
  }, [initial.id, newest, onRead]);

  async function deliver(item: PendingMessage) {
    try {
      const message = await withRoomDeadline(
        client.post({
          room_id: initial.id,
          text: item.text,
          idempotency_key: item.key,
          ...(item.agentId ? { agent_id: item.agentId } : {}),
        }),
      );
      thread.merge([message]);
      setPending((list) => list.filter((entry) => entry.key !== item.key));
    } catch (err) {
      setPending((list) =>
        list.map((entry) => (entry.key === item.key ? { ...entry, failed: describe(err) } : entry)),
      );
    }
  }
  function send(text: string, agentId?: string) {
    const sender = (agentId ? own.find((member) => member.id === agentId) : own[0])?.name ?? 'You';
    // One key per message, kept for every Retry so a retry cannot duplicate it.
    const item: PendingMessage = {
      key: crypto.randomUUID(),
      text,
      agentId,
      sender,
      afterSeq: thread.messages.at(-1)?.seq ?? 0,
    };
    setPending((list) => [...list, item]);
    setFollow((value) => value + 1);
    void deliver(item);
  }
  function retry(key: string) {
    const item = pendingRef.current.find((entry) => entry.key === key);
    if (!item) return;
    const next = { ...item, failed: undefined };
    setPending((list) => list.map((entry) => (entry.key === key ? next : entry)));
    void deliver(next);
  }

  useEffect(() => {
    if (!wantInvite.current || !room.name) return;
    wantInvite.current = false;
    window.history.replaceState({ ...(window.history.state ?? {}), invite: false }, '');
    if (room.role === 'host' && !room.closed) setInvite(true);
  }, [room.name, room.role, room.closed]);

  const host = room.role === 'host';
  const canPost = thread.ready && !room.closed && !room.readOnly && !thread.denied;
  return (
    <section className="rm-room" aria-label={room.name}>
      <header className="rm-room-head">
        <button
          type="button"
          className="rm-icon rm-menu"
          aria-label="Open rooms"
          onClick={onOpenMenu}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        <div className="rm-room-title">
          <h1>{room.name}</h1>
          {room.topic ? <p className="rm-meta">{room.topic}</p> : null}
        </div>
        <button
          type="button"
          className="rm-quiet"
          aria-label={`Members, ${room.member_count}`}
          aria-expanded={panel === 'members'}
          onClick={() => setPanel((value) => (value === 'members' ? null : 'members'))}
        >
          <Users size={16} aria-hidden="true" />
          {room.member_count}
        </button>
        {/* Only when the server offers room tasks (the list answers 404 otherwise). */}
        {tasks.available ? (
          <button
            type="button"
            className="rm-quiet"
            aria-label={`Tasks, ${tasks.tasks ? activeCount(tasks.tasks) : 0} to do`}
            aria-expanded={panel === 'tasks'}
            onClick={() => setPanel((value) => (value === 'tasks' ? null : 'tasks'))}
          >
            <ListChecks size={16} aria-hidden="true" />
            <span className="rm-head-label">Tasks</span>
            {tasks.tasks && activeCount(tasks.tasks) ? (
              <span className="rm-task-count">{activeCount(tasks.tasks)}</span>
            ) : null}
          </button>
        ) : null}
        {/* Only when the server offers room repositories (the route answers 404 otherwise). */}
        {repo.available ? (
          <button
            type="button"
            className="rm-quiet"
            aria-label={
              repo.state?.binding ? `Code, connected to ${repo.state.binding.repo}` : 'Code'
            }
            aria-expanded={panel === 'code'}
            onClick={() => setPanel((value) => (value === 'code' ? null : 'code'))}
          >
            <Code2 size={16} aria-hidden="true" />
            <span className="rm-head-label">Code</span>
          </button>
        ) : null}
        {host && !room.closed ? (
          <button type="button" className="rm-primary" onClick={() => setInvite(true)}>
            Invite
          </button>
        ) : null}
      </header>
      {personSelf && !host ? (
        <p className="rm-banner rm-joined" role="status">
          <span>
            You joined as {personSelf.name}.{hostMember ? ` Invited by ${hostMember.name}.` : ''}
          </span>
          {room.membersMayBringAi !== false && !room.closed ? (
            <span>
              Want to bring your AI too?{' '}
              {/* The console's "Connect your AI" view (App.tsx reads #connect on load). */}
              <a href="/#connect">Connect your AI</a>, then paste the room's invite link into it.
            </span>
          ) : null}
        </p>
      ) : null}
      {!online ? (
        <p className="rm-banner" role="status">
          You're offline. We'll reconnect automatically.
        </p>
      ) : null}
      <div className="rm-room-body">
        <div className="rm-thread">
          {thread.error ? (
            <div className="rm-inline-error" role="alert">
              <span>{thread.error}</span>
              {thread.denied ? null : (
                <button type="button" className="rm-quiet" onClick={() => void thread.refresh()}>
                  Retry
                </button>
              )}
            </div>
          ) : null}
          {!thread.ready && !thread.error ? (
            <div className="rm-skeletons" role="status" aria-label="Loading messages">
              {[0, 1, 2, 3, 4, 5].map((index) => (
                <span key={index} className={index % 2 ? 'right' : ''} />
              ))}
            </div>
          ) : null}
          {thread.ready ? (
            thread.messages.length || pending.length ? (
              <MessageList
                messages={thread.messages}
                pending={pending}
                members={members}
                hasOlder={thread.hasOlder}
                loadingOlder={thread.loadingOlder}
                onOlder={thread.loadOlder}
                onRetry={retry}
                onDiscard={(key) => setPending((list) => list.filter((entry) => entry.key !== key))}
                onTrim={thread.trim}
                follow={follow}
              >
                <p className="rm-notice">{NOTICE}</p>
              </MessageList>
            ) : (
              <div className="rm-empty">
                <p className="rm-notice">{NOTICE}</p>
                <h2>This room is quiet</h2>
                {host && !room.closed ? (
                  <button type="button" className="rm-primary" onClick={() => setInvite(true)}>
                    Invite
                  </button>
                ) : null}
              </div>
            )
          ) : null}
          {thread.denied ? null : room.closed ? (
            <p className="rm-readonly">This room is closed. Its history stays readable.</p>
          ) : room.readOnly ? (
            <p className="rm-readonly">You can read this room but not post.</p>
          ) : canPost ? (
            <Composer
              roomName={room.name}
              members={members}
              own={own}
              draft={draft}
              onDraft={onDraft}
              onSend={send}
              disabled={online ? '' : "You're offline"}
            />
          ) : null}
        </div>
        {panel === 'members' ? (
          <MembersPanel
            client={client}
            room={room}
            members={members}
            onChanged={() => {
              void loadMembers();
              void thread.refresh();
              onRoomChanged();
            }}
            onClose={() => setPanel(null)}
            onLeft={() => {
              setPanel(null);
              // Refresh the list first; this view unmounts once the room is gone from it and
              // then goes to /rooms (see the effect below), so /rooms never reopens it from a
              // stale list.
              left.current = true;
              onRoomChanged();
            }}
          />
        ) : panel === 'tasks' ? (
          <TasksPanel room={room} members={members} state={tasks} onClose={() => setPanel(null)} />
        ) : panel === 'code' ? (
          <RepoPanel room={room} repo={repo} onClose={() => setPanel(null)} />
        ) : null}
      </div>
      {invite ? (
        <InviteSheet
          client={client}
          room={room}
          onRoomChanged={() => {
            void thread.refresh();
            onRoomChanged();
          }}
          onClose={() => {
            setInvite(false);
            void loadMembers();
            void thread.refresh();
          }}
        />
      ) : null}
    </section>
  );
}
