import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  lazy,
  Suspense,
} from 'react';
import {
  Bell,
  BellOff,
  Bot,
  Code2,
  Ellipsis,
  LayoutList,
  ListChecks,
  Menu,
  Plug,
  Settings2,
  Users,
  X,
} from 'lucide-react';
import {
  addElricToRoom,
  getElricStatus,
  withRoomDeadline,
  type ElricNotice,
  type ElricStatus,
  type LeftMember,
  type Member,
  type MemberStatus,
  type Room,
  type RoomsClient,
} from './api';
import { Composer } from './Composer';
import {
  AddElricCard,
  ElricNoticeBanner,
  ElricAiNoticeBanner,
  ElricWakingPill,
  ElricAgeDialog,
  ElricDobDialog,
  type ElricAgeReason,
} from './elric';
import { InviteSheet } from './InviteSheet';
import { initialOf, MessageList, type PendingMessage } from './MessageList';
import { ownerNames, possessive } from './people';
import { activeCount } from './tasks';
import { TasksPanel, useRoomTasks } from './TasksPanel';
import { RepoPanel, useRoomRepo } from './RepoPanel';
import { api } from '../api';
import { ELRIC_MEMBER_BADGE } from '../../shared/elric-copy';
import { describe, useRoomThread } from './useRoomThread';
import { ConfirmRow, RoomSettings } from './RoomSettings';
import { Switch, SwitchToast, useOptimisticSwitch } from '../ui/Switch';
import { navigate } from '../shell/navigation';

/** Loaded on first open, so room pages don't download the Connect page's code up front. */
const ConnectAiSheet = lazy(() =>
  import('./ConnectAiSheet').then((module) => ({ default: module.ConnectAiSheet })),
);

/** A removal reason: at most 200 characters (docs/ROOM_MANAGEMENT.md). */
const REASON_MAX = 200;

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

/**
 * The Remove confirmation: the question (a removed member can't rejoin) and an optional reason
 * the removed member sees. For a guest (no account) it also offers to reset the invite link, off
 * by default. Cancel takes focus, as in every inline confirmation.
 */
function RemoveConfirm({
  question,
  guest,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  /** A guest without an account: it could come back through a live link as a new member. */
  guest: boolean;
  busy: boolean;
  onConfirm: (input: { reason: string; resetLink: boolean }) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [resetLink, setResetLink] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="rm-confirm rm-remove-confirm" role="group" aria-label={question}>
      <span className="rm-confirm-text">{question}</span>
      <label className="rm-remove-field" htmlFor={`${id}-reason`}>
        Reason (shown to the removed member)
      </label>
      <input
        id={`${id}-reason`}
        className="rm-input"
        value={reason}
        maxLength={REASON_MAX}
        placeholder="Optional"
        autoComplete="off"
        onChange={(event) => setReason(event.target.value)}
      />
      {guest ? (
        <>
          <label className="rm-check">
            <input
              type="checkbox"
              checked={resetLink}
              onChange={(event) => setResetLink(event.target.checked)}
            />
            Also reset the invite link
          </label>
          <span className="rm-remove-note">
            Others on the same network can't join this room as guests for 30 days.
          </span>
        </>
      ) : null}
      <span className="rm-confirm-actions">
        <button
          type="button"
          className="rm-danger rm-danger-solid"
          disabled={busy}
          onClick={() => onConfirm({ reason: reason.trim(), resetLink: guest && resetLink })}
        >
          Remove
        </button>
        <button ref={cancelRef} type="button" className="rm-quiet" onClick={onCancel}>
          Cancel
        </button>
      </span>
    </div>
  );
}

/**
 * Members panel: the member list, and for the host Mute/Unmute, Remove (with confirmation; a
 * removed member cannot rejoin) and Close room. Members that recently left are only listed.
 */
function MembersPanel({
  client,
  room,
  members,
  elric,
  onChanged,
  onClose,
  onLeft,
}: {
  client: RoomsClient;
  room: Room;
  members: Member[];
  /** "Elric in this room": one switch (on = member, off = removed); absent when Elric is off. */
  elric?: ElricRoomSwitch;
  onChanged: () => void;
  onClose: () => void;
  /** After your agents left: the room is no longer yours to open. */
  onLeft: () => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** Cancel a confirmation and put focus back on the button that opened it. */
  function cancel() {
    const key = confirm;
    setConfirm(null);
    if (key === null) return;
    requestAnimationFrame(() =>
      panelRef.current?.querySelector<HTMLElement>(`[data-confirm="${CSS.escape(key)}"]`)?.focus(),
    );
  }
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
  /** Remove (always blocks rejoining); for a guest, optionally reset the invite link after. */
  async function removeMember(member: Member, input: { reason: string; resetLink: boolean }) {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.remove({
          room_id: room.id,
          agent_id: member.id,
          ...(input.reason ? { reason: input.reason } : {}),
          block_rejoin: true,
        }),
      );
    } catch (err) {
      setError(describe(err));
      setBusy(false);
      return;
    }
    setConfirm(null);
    onChanged();
    if (input.resetLink)
      try {
        await withRoomDeadline(
          client.rotate({ room_id: room.id, idempotency_key: crypto.randomUUID() }),
        );
      } catch {
        setError(
          `${member.name} was removed, but the invite link wasn't reset. Reset it from Invite.`,
        );
      }
    setBusy(false);
  }
  const hostName = members.find((member) => member.role === 'host');
  // Host: members that left on their own recently; listed only, with no action.
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
  // Host: which members are muted (they still read, but cannot post).
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!host || room.closed) return;
    let active = true;
    withRoomDeadline(client.mutes({ room_id: room.id }))
      .then((list) => active && setMuted(new Set(list.map((entry) => entry.agent_id))))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, host, room.id, room.closed, members]);
  const [muting, setMuting] = useState<string | null>(null);
  /** Mute or unmute at once (no confirmation: it is undone the same way). */
  async function toggleMute(member: Member) {
    const mute = !muted.has(member.id);
    setMuting(member.id);
    setError('');
    try {
      await withRoomDeadline(client.mute({ room_id: room.id, agent_id: member.id, muted: mute }));
      setMuted((current) => {
        const next = new Set(current);
        if (mute) next.add(member.id);
        else next.delete(member.id);
        return next;
      });
    } catch (err) {
      setError(`Couldn't ${mute ? 'mute' : 'unmute'} ${member.name}. ${describe(err)}`);
    } finally {
      setMuting(null);
    }
  }
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
    <aside className="rm-panel" aria-label="Members" ref={panelRef}>
      <div className="rm-sheet-head">
        <h2>
          <Users size={16} aria-hidden="true" />
          Members · {members.length}
        </h2>
        <button type="button" className="rm-icon" aria-label="Close members" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      {elric ? <ElricSwitchRow elric={elric} /> : null}
      <ul className="rm-members" aria-label="Current members">
        {members.map((member) => (
          <li key={member.id}>
            <span
              className="rm-avatar"
              data-kind={
                member.auto_reply?.provider === 'elric' ? 'elric' : (member.kind ?? 'agent')
              }
              aria-hidden="true"
            >
              {initialOf(member.name)}
            </span>
            <div>
              <strong>
                {member.name}
                {member.kind === 'person' ? <span className="rm-person">person</span> : null}
              </strong>
              <span className="rm-meta">
                {member.auto_reply?.provider === 'elric' ? (
                  ELRIC_MEMBER_BADGE
                ) : member.own ? (
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
              {host && muted.has(member.id) ? <span className="rm-muted-label">Muted</span> : null}
            </div>
            {host &&
            member.role !== 'host' &&
            !room.closed &&
            !(elric && member.auto_reply?.provider === 'elric') ? (
              confirm === member.id ? (
                <RemoveConfirm
                  question={`Remove ${member.name}? They can't rejoin.`}
                  guest={member.guest === true}
                  busy={busy}
                  onConfirm={(input) => void removeMember(member, input)}
                  onCancel={cancel}
                />
              ) : (
                <span className="rm-member-actions">
                  {member.own ? null : (
                    <button
                      type="button"
                      className="rm-quiet"
                      aria-label={`${muted.has(member.id) ? 'Unmute' : 'Mute'} ${member.name}`}
                      disabled={muting === member.id}
                      onClick={() => void toggleMute(member)}
                    >
                      {muted.has(member.id) ? 'Unmute' : 'Mute'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="rm-quiet"
                    aria-label={`Remove ${member.name}`}
                    data-confirm={member.id}
                    onClick={() => setConfirm(member.id)}
                  >
                    Remove
                  </button>
                </span>
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
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {host ? (
        room.closed ? null : confirm === 'close' ? (
          <ConfirmRow
            question="Nobody can post after this. History stays readable."
            action="Confirm close"
            busy={busy}
            onConfirm={() => void act(() => client.close({ room_id: room.id }))}
            onCancel={cancel}
          />
        ) : (
          <div className="rm-leave">
            <p className="rm-meta">
              You host this room, so you can't leave it. Close it to end it.
            </p>
            <button
              type="button"
              className="rm-quiet danger"
              data-confirm="close"
              onClick={() => setConfirm('close')}
            >
              Close room
            </button>
          </div>
        )
      ) : (
        <div className="rm-leave">
          {hostName ? <p className="rm-meta">Only the host ({hostName.name}) can invite.</p> : null}
          {leaving.length ? (
            confirm === 'leave' ? (
              <ConfirmRow
                question={`${leaving.length > 1 ? 'Your agents stop' : 'Your agent stops'} reading and posting here. You can rejoin with an invite link.`}
                action="Confirm leave"
                busy={busy}
                onConfirm={() => void leave()}
                onCancel={cancel}
              />
            ) : (
              <button
                type="button"
                className="rm-quiet danger"
                data-confirm="leave"
                onClick={() => setConfirm('leave')}
              >
                Leave room
              </button>
            )
          ) : null}
        </div>
      )}
    </aside>
  );
}

/** The Members panel's "Elric in this room" switch: state, why it's disabled, and the change. */
type ElricRoomSwitch = {
  on: boolean;
  disabledReason: string | null;
  /** Resolves when the change is done; rejects to roll the switch back. */
  change: (next: boolean) => Promise<void>;
};

/**
 * "Elric in this room" as one switch: in the Members panel, and (compact, label "Elric") in the
 * room header next to Members for the host. Both follow the same membership.
 */
function ElricSwitchRow({ elric, compact = false }: { elric: ElricRoomSwitch; compact?: boolean }) {
  const failure = useCallback(
    (next: boolean) =>
      next ? 'Elric couldn’t join this room. Try again.' : 'Elric couldn’t be removed. Try again.',
    [],
  );
  const toggle = useOptimisticSwitch(elric.on, elric.change, failure);
  return (
    <div className={compact ? 'rm-head-elric' : 'rm-members-add-elric'}>
      <Switch
        label={compact ? 'Elric' : 'Elric in this room'}
        checked={toggle.shown}
        busy={toggle.busy}
        disabledReason={elric.disabledReason}
        onChange={(next) => void toggle.set(next)}
      />
      <SwitchToast text={toggle.toast} onDismiss={toggle.dismiss} />
    </div>
  );
}

type MenuItem = { key: string; label: string; icon: ReactNode; onSelect: () => void };

/** The top bar's "…" menu: a small popup menu (Escape and outside clicks close it). */
function MoreMenu({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const list = [...(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
      const index = list.indexOf(document.activeElement as HTMLElement);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      list[(index + step + list.length) % list.length]?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', keys);
    };
  }, [open]);
  return (
    <div className="rm-more" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="rm-outline rm-icon-btn"
        aria-label="More room actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Ellipsis size={18} aria-hidden="true" />
      </button>
      {open ? (
        <div className="rm-more-menu" role="menu" aria-label="More room actions">
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              tabIndex={-1}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** "Room list": the rooms overview, by the same navigation the app shell uses. */
function goRoomList(event: ReactMouseEvent<HTMLAnchorElement>) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return;
  event.preventDefault();
  navigate('/rooms');
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
  userId,
}: {
  client: RoomsClient;
  room: Room;
  draft: string;
  onDraft: (text: string) => void;
  onOpenMenu: () => void;
  onRoomChanged: () => void;
  /** The newest seq shown, for unread counts. */
  onRead: (roomId: string, seq: number) => void;
  userId?: string;
}) {
  const thread = useRoomThread(client, initial.id, initial.latest_seq);
  const room = thread.room ?? initial;
  const [notificationsMuted, setNotificationsMuted] = useState(
    () => initial.notificationsMuted === true,
  );
  useEffect(() => {
    if (room.notificationsMuted !== undefined) {
      setNotificationsMuted(room.notificationsMuted === true);
    }
  }, [room.notificationsMuted]);
  const [notificationError, setNotificationError] = useState('');

  async function toggleNotificationsMute() {
    const next = !notificationsMuted;
    setNotificationsMuted(next);
    setNotificationError('');
    try {
      await withRoomDeadline(client.muteNotifications({ room_id: initial.id, muted: next }));
      onRoomChanged();
    } catch {
      setNotificationsMuted(!next);
      setNotificationError("Couldn't change notifications. Try again.");
    }
  }
  const [members, setMembers] = useState<Member[]>([]);
  // One side panel at a time: members, room settings, the room's tasks or its code.
  const [panel, setPanel] = useState<'members' | 'settings' | 'tasks' | 'code' | null>(null);
  const tasks = useRoomTasks(initial.id, panel === 'tasks');
  const repo = useRoomRepo(initial.id);
  // The shell's "Invite your AI" lands here with history.state.invite: open the sheet once,
  // as soon as the room is known to be an open room this viewer hosts.
  const [invite, setInvite] = useState(false);
  const [connect, setConnect] = useState(false);
  // "Add a task" from the composer opens the Tasks panel with its form.
  const [taskForm, setTaskForm] = useState(0);
  const wantInvite = useRef((window.history.state as { invite?: boolean } | null)?.invite === true);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [follow, setFollow] = useState(0);
  const online = useOnline();

  // Elric state
  const [elricStatus, setElricStatus] = useState<ElricStatus | null>(null);
  const [addElricDismissed, setAddElricDismissed] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(`cc_dismiss_add_elric_${initial.id}`) === '1';
    } catch {
      return false;
    }
  });
  const [addingElric, setAddingElric] = useState<boolean>(false);
  const [addElricError, setAddElricError] = useState<string | null>(null);
  const [elricWaking, setElricWaking] = useState<boolean>(false);
  const [elricWakingSeq, setElricWakingSeq] = useState<number | null>(null);
  // The answer forming for the viewer's own @Elric post (streamed drafts), and when it started.
  const [elricDraft, setElricDraft] = useState<{ text: string; since: number } | null>(null);
  const [elricNotice, setElricNotice] = useState<ElricNotice | null>(null);
  const noticeKey = `cc_elric_ai_notice_${userId ? `${userId}_` : ''}${initial.id}`;
  const [aiNoticeDismissed, setAiNoticeDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(noticeKey) === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      setAiNoticeDismissed(localStorage.getItem(noticeKey) === '1');
    } catch {
      setAiNoticeDismissed(false);
    }
  }, [noticeKey]);

  function handleDismissAiNotice() {
    setAiNoticeDismissed(true);
    try {
      localStorage.setItem(noticeKey, '1');
    } catch {}
  }
  const [showDobDialog, setShowDobDialog] = useState<boolean>(false);
  const [ageRefusal, setAgeRefusal] = useState<ElricAgeReason | null>(null);

  useEffect(() => {
    let active = true;
    void getElricStatus().then((status) => {
      if (active) setElricStatus(status);
    });
    return () => {
      active = false;
    };
  }, []);

  const isElricMember = useMemo(
    () =>
      members.some(
        (m) =>
          m.auto_reply?.provider === 'elric' ||
          (elricStatus?.agent_id && m.id === elricStatus.agent_id),
      ),
    [members, elricStatus?.agent_id],
  );

  const host = room.role === 'host';
  // Add Elric shows for a verified adult and also when only the date of birth is missing
  // ('age_unknown': the click asks for it once). Never under 18 or without Google sign-in.
  const elricAddable = Boolean(
    elricStatus?.eligible || elricStatus?.eligibility_reason === 'age_unknown',
  );
  const canAddElric = Boolean(host && !isElricMember && elricAddable && !room.closed);

  const showAddElric = Boolean(
    canAddElric && room.respondersAllowed !== false && !addElricDismissed,
  );

  function handleClickAddElric() {
    setAddElricError(null);
    setAddElricDismissed(false);
    try {
      sessionStorage.removeItem(`cc_dismiss_add_elric_${initial.id}`);
    } catch {}
    if (elricStatus?.over_18) {
      void handleAddElric();
    } else {
      setShowDobDialog(true);
    }
  }

  async function handleDobSubmit(dob: string) {
    await handleAddElric(dob);
  }

  async function handleAddElric(dob?: string) {
    setAddingElric(true);
    setAddElricError(null);
    try {
      await addElricToRoom(client, initial.id, dob);
      setShowDobDialog(false);
      if (dob) {
        setElricStatus((prev) => (prev ? { ...prev, over_18: true } : prev));
      }
      await loadMembers();
      onRoomChanged();
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'elric_age_under_18') {
        setShowDobDialog(false);
        setAgeRefusal('under_18');
      } else if (code === 'elric_age_unknown') {
        setShowDobDialog(false);
        setAgeRefusal('unknown');
      } else if (code === 'invalid_date_of_birth') {
        setAddElricError('Please enter a valid date of birth.');
      } else {
        setAddElricError(describe(err) || 'Could not add Elric to room.');
      }
    } finally {
      setAddingElric(false);
    }
  }

  // The Members panel switch. On: add (the first time asks the date of birth once, then the
  // members refresh flips it). Off: remove Elric without blocking it from being added again.
  const elricMember = members.find(
    (m) =>
      m.auto_reply?.provider === 'elric' ||
      (elricStatus?.agent_id && m.id === elricStatus.agent_id),
  );
  const elricSwitch: ElricRoomSwitch | null = elricStatus
    ? {
        on: Boolean(elricMember),
        disabledReason: room.closed
          ? 'This room is closed.'
          : !host
            ? 'Only the room’s host can add or remove Elric.'
            : !elricMember && !elricAddable
              ? elricStatus.eligibility_reason === 'age_under_18'
                ? 'Elric is available from age 18.'
                : elricStatus.eligibility_reason === 'unverified'
                  ? 'Elric needs Google sign-in (Account settings).'
                  : 'Elric isn’t available for your account.'
              : null,
        change: async (next) => {
          if (next) {
            if (!elricStatus.over_18) {
              // The date-of-birth sheet takes over; the switch follows the membership.
              handleClickAddElric();
              throw Object.assign(new Error('dob'), { silent: true });
            }
            await addElricToRoom(client, initial.id);
          } else if (elricMember) {
            await withRoomDeadline(
              client.remove({ room_id: initial.id, agent_id: elricMember.id, block_rejoin: false }),
            );
          }
          await loadMembers();
          onRoomChanged();
        },
      }
    : null;

  function handleDismissAddElric() {
    setAddElricDismissed(true);
    try {
      sessionStorage.setItem(`cc_dismiss_add_elric_${initial.id}`, '1');
    } catch {}
  }
  const own = members.filter((member) => member.own && member.auto_reply?.provider !== 'elric');
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
    const mentionsElric = /@elric\b/i.test(item.text);
    const canInvokeElric = isElricMember && room.respondersAllowed !== false;
    if (mentionsElric && canInvokeElric) {
      setElricWaking(true);
    }
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
      if (mentionsElric && canInvokeElric) {
        setElricWakingSeq(message.seq);
      }
      if (message.elric_notice) {
        setElricNotice(message.elric_notice);
        setElricWaking(false);
        setElricWakingSeq(null);
      }
    } catch (err) {
      if (mentionsElric && canInvokeElric) {
        setElricWaking(false);
        setElricWakingSeq(null);
      }
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

  // Elric answered the viewer's post: only a reply AFTER that post counts (an earlier Elric
  // message in the thread must not end the wait before the post is even delivered). This also
  // ends the streamed draft (elricWakingSeq back to null).
  useEffect(() => {
    if (elricWakingSeq === null) return;
    const repliesAfter = thread.messages.filter((m) => m.seq > elricWakingSeq);
    const hasElricReply = repliesAfter.some(
      (m) =>
        m.auto_reply?.provider === 'elric' ||
        (elricStatus?.agent_id && m.sender_agent_id === elricStatus.agent_id) ||
        members.some(
          (member) => member.id === m.sender_agent_id && member.auto_reply?.provider === 'elric',
        ),
    );
    if (hasElricReply) {
      setElricWaking(false);
      setElricWakingSeq(null);
    }
  }, [thread.messages, elricWakingSeq, elricStatus?.agent_id, members]);

  // Streamed answers: after the viewer's own @Elric post, read the forming answer every 500 ms
  // (up to 60 s). It shows in Elric's place in the thread; when the draft goes away the room is
  // read at once, so the posted message replaces it.
  useEffect(() => {
    if (elricWakingSeq === null) {
      setElricDraft(null);
      return;
    }
    const since = Date.now();
    setElricDraft({ text: '', since });
    let live = true;
    let seen = false;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      try {
        const { drafts } = await api<{ drafts: { source_seq: number; text: string }[] }>(
          `/api/rooms/${encodeURIComponent(initial.id)}/elric-drafts`,
          undefined,
          'GET',
        );
        if (!live) return;
        const mine = drafts.find((item) => item.source_seq === elricWakingSeq);
        if (mine) {
          seen = true;
          setElricDraft({ text: mine.text, since });
        } else if (seen) {
          setElricDraft(null);
          void thread.refresh();
          return;
        }
      } catch {
        // Drafts are a preview; the posted message still arrives through the room's updates.
      }
      if (live && Date.now() - since < 60_000) timer = window.setTimeout(tick, 500);
      else if (live) setElricDraft(null);
    };
    timer = window.setTimeout(tick, 500);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [elricWakingSeq, initial.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!elricWaking) return;
    const timer = setTimeout(() => {
      setElricWaking(false);
      setElricWakingSeq(null);
    }, 60_000); // The 55 s run budget plus delivery (the streamed draft keeps it company).
    return () => clearTimeout(timer);
  }, [elricWaking]);

  useEffect(() => {
    if (!wantInvite.current || !room.name) return;
    wantInvite.current = false;
    window.history.replaceState({ ...(window.history.state ?? {}), invite: false }, '');
    if (room.role === 'host' && !room.closed) setInvite(true);
  }, [room.name, room.role, room.closed]);

  const canPost = thread.ready && !room.closed && !room.readOnly && !thread.denied;
  return (
    <section className="rm-room" aria-label={room.name}>
      <header className="rm-room-head">
        <button
          type="button"
          className="rm-icon rm-menu"
          aria-label="Open menu"
          onClick={onOpenMenu}
        >
          <Menu size={20} aria-hidden="true" />
        </button>
        {/* The room's name is in the sidebar; the heading stays for assistive technology. */}
        <h1 className="rm-visually-hidden">{room.name}</h1>
        <nav className="rm-crumbs" aria-label="Breadcrumb">
          <a href="/rooms" aria-label="Room list" onClick={goRoomList}>
            <LayoutList size={16} aria-hidden="true" />
            <span className="rm-head-label">Room list</span>
          </a>
        </nav>
        <div className="rm-head-actions">
          <button
            type="button"
            className="rm-outline rm-head-btn"
            aria-label={`Members, ${room.member_count}`}
            aria-expanded={panel === 'members'}
            onClick={() => setPanel((value) => (value === 'members' ? null : 'members'))}
          >
            <Users size={16} aria-hidden="true" />
            <span className="rm-head-label">Members</span>
            <span className="rm-count">{room.member_count}</span>
          </button>
          {/* Elric on/off for the host, one click (same rules as the Members panel switch). */}
          {host && elricSwitch ? <ElricSwitchRow elric={elricSwitch} compact /> : null}
          {/* Only when the server offers room tasks (the list answers 404 otherwise). */}
          {tasks.available ? (
            <button
              type="button"
              className="rm-outline rm-head-btn"
              aria-label={`Tasks, ${tasks.tasks ? activeCount(tasks.tasks) : 0} to do`}
              aria-expanded={panel === 'tasks'}
              onClick={() => {
                setTaskForm(0);
                setPanel((value) => (value === 'tasks' ? null : 'tasks'));
              }}
            >
              <ListChecks size={16} aria-hidden="true" />
              <span className="rm-head-label">Tasks</span>
              {tasks.tasks && activeCount(tasks.tasks) ? (
                <span className="rm-count rm-task-count">{activeCount(tasks.tasks)}</span>
              ) : null}
            </button>
          ) : null}
          {room.closed ? null : (
            <button
              type="button"
              className="rm-outline rm-head-btn"
              aria-haspopup="dialog"
              onClick={() => setConnect(true)}
            >
              <Plug size={16} aria-hidden="true" />
              <span className="rm-head-label">Connect AI</span>
            </button>
          )}
          {host && !room.closed ? (
            <button
              type="button"
              className="rm-primary rm-head-btn"
              onClick={() => setInvite(true)}
            >
              Invite
            </button>
          ) : null}
          <MoreMenu
            items={[
              // Elric on/off is the Members panel switch; the menu only links to the console.
              ...(elricStatus
                ? [
                    {
                      key: 'manage-elric',
                      label: 'Manage Elric',
                      icon: <Bot size={16} aria-hidden="true" />,
                      onSelect: () => navigate('/elric'),
                    },
                  ]
                : []),
              // Only when the server offers room repositories (the route answers 404 otherwise).
              ...(repo.available
                ? [
                    {
                      key: 'code',
                      label: repo.state?.binding
                        ? `Code, connected to ${repo.state.binding.repo}`
                        : 'Code',
                      icon: <Code2 size={16} aria-hidden="true" />,
                      onSelect: () => setPanel('code'),
                    },
                  ]
                : []),
              {
                key: 'settings',
                label: 'Room settings',
                icon: <Settings2 size={16} aria-hidden="true" />,
                onSelect: () => setPanel('settings'),
              },
              {
                key: 'notifications',
                label: notificationsMuted ? 'Unmute this room' : 'Mute this room',
                icon: notificationsMuted ? (
                  <Bell size={16} aria-hidden="true" />
                ) : (
                  <BellOff size={16} aria-hidden="true" />
                ),
                onSelect: () => void toggleNotificationsMute(),
              },
            ]}
          />
        </div>
      </header>
      {notificationError ? (
        <p className="rm-inline-error" role="alert">
          {notificationError}
        </p>
      ) : null}
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
                elricDraft={elricDraft}
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
          {elricWaking || elricNotice || (isElricMember && !aiNoticeDismissed) ? (
            <div className="rm-elric-banner-wrap">
              {isElricMember && !aiNoticeDismissed ? (
                <ElricAiNoticeBanner onDismiss={handleDismissAiNotice} />
              ) : null}
              {elricWaking ? <ElricWakingPill /> : null}
              {elricNotice ? (
                <ElricNoticeBanner notice={elricNotice} onDismiss={() => setElricNotice(null)} />
              ) : null}
            </div>
          ) : null}
          {showAddElric ? (
            <AddElricCard
              onAdd={handleClickAddElric}
              onDismiss={handleDismissAddElric}
              busy={addingElric}
              error={!showDobDialog ? addElricError : null}
            />
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
              onTask={
                tasks.available && host
                  ? () => {
                      setPanel('tasks');
                      setTaskForm((value) => value + 1);
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
        {panel === 'members' ? (
          <MembersPanel
            client={client}
            room={room}
            members={members}
            {...(elricSwitch ? { elric: elricSwitch } : {})}
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
        ) : panel === 'settings' ? (
          <RoomSettings
            client={client}
            room={room}
            members={members}
            ready={thread.ready}
            onManageMembers={() => setPanel('members')}
            onChanged={() => {
              void loadMembers();
              void thread.refresh();
              onRoomChanged();
            }}
            onDeleted={() => {
              setPanel(null);
              // Reload the list (the room leaves it) and go to the room list right away.
              onRoomChanged();
              navigate('/rooms');
            }}
            onClose={() => setPanel(null)}
          />
        ) : panel === 'tasks' ? (
          <TasksPanel
            room={room}
            members={members}
            state={tasks}
            startAdding={taskForm}
            onClose={() => {
              setPanel(null);
              setTaskForm(0);
            }}
          />
        ) : panel === 'code' ? (
          <RepoPanel room={room} repo={repo} onClose={() => setPanel(null)} />
        ) : null}
      </div>
      {connect ? (
        <Suspense fallback={null}>
          <ConnectAiSheet
            host={host}
            onInvite={() => {
              setConnect(false);
              setInvite(true);
            }}
            onClose={() => setConnect(false)}
          />
        </Suspense>
      ) : null}
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
      {showDobDialog ? (
        <ElricDobDialog
          busy={addingElric}
          error={addElricError}
          onSubmit={handleDobSubmit}
          onClose={() => {
            setShowDobDialog(false);
            setAddElricError(null);
          }}
        />
      ) : null}
      {ageRefusal ? (
        <ElricAgeDialog reason={ageRefusal} onClose={() => setAgeRefusal(null)} />
      ) : null}
    </section>
  );
}
