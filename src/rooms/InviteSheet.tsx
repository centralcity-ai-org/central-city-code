import { useEffect, useRef, useState } from 'react';
import { Check, Copy, LoaderCircle, X } from 'lucide-react';
import { withRoomDeadline, type History, type JoinLink, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';
// How an outside AI joins with the link: one wording, shared with the Connect page.
import { CHATGPT_ADMIN_NOTE, ROOM_INVITE_CLIENTS, roomInviteCopyLine } from '../shell/roomInvite';

/** Members are polled while the sheet is open, for at most 10 minutes. */
const MEMBER_POLL_MS = 3_000;
const MEMBER_POLL_LIMIT_MS = 10 * 60_000;
const PULSE_MS = 60_000;

/** One join link per room for this page's lifetime; the code is never written to storage. */
const cache = new Map<string, JoinLink>();

/** The one link, host only (decision E1). */
export function InviteSheet({
  client,
  room,
  onClose,
  onRoomChanged,
}: {
  client: RoomsClient;
  room: Room;
  onClose: () => void;
  /** After the host changes a room setting (history). */
  onRoomChanged?: () => void;
}) {
  const [link, setLink] = useState<JoinLink | null>(() => cache.get(room.id) ?? null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [copyHint, setCopyHint] = useState('');
  const [joined, setJoined] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<'pulse' | 'still'>('pulse');
  const [confirmNew, setConfirmNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [notice, setNotice] = useState('');
  const rotateKey = useRef(crypto.randomUUID());
  const dialog = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [history, setHistory] = useState<History>(room.history);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyError, setHistoryError] = useState('');
  useEffect(() => setHistory(room.history), [room.history]);
  // Host settings for people (migration 31): both on by default.
  const [people, setPeople] = useState({
    join: room.peopleMayJoin !== false,
    bringAi: room.membersMayBringAi !== false,
  });
  const [peopleError, setPeopleError] = useState('');
  // Member cap (people and AIs share it): the host raises or lowers it, never below today's members.
  const [cap, setCap] = useState(String(room.member_cap ?? ''));
  const [capNote, setCapNote] = useState('');
  useEffect(() => setCap(String(room.member_cap ?? '')), [room.member_cap]);
  async function saveCap() {
    const value = Number(cap);
    if (!Number.isInteger(value)) return;
    setCapNote('');
    try {
      const updated = await withRoomDeadline(
        client.setMemberCap({ room_id: room.id, member_cap: value }),
      );
      setCap(String(updated.member_cap ?? value));
      setCapNote('Saved.');
      onRoomChanged?.();
    } catch (err) {
      setCap(String(room.member_cap ?? ''));
      setCapNote(describe(err));
    }
  }
  async function changePeople(next: { join: boolean; bringAi: boolean }) {
    const previous = people;
    setPeople(next);
    setPeopleError('');
    try {
      const updated = await withRoomDeadline(
        client.setPeople({
          room_id: room.id,
          people_may_join: next.join,
          members_may_bring_ai: next.bringAi,
        }),
      );
      setPeople({
        join: updated.peopleMayJoin !== false,
        bringAi: updated.membersMayBringAi !== false,
      });
      onRoomChanged?.();
    } catch (err) {
      setPeople(previous);
      setPeopleError(describe(err));
    }
  }

  useEffect(() => {
    if (link) return;
    let active = true;
    setError('');
    withRoomDeadline(client.joinLink({ room_id: room.id }))
      .then((value) => {
        if (!active) return;
        cache.set(room.id, value);
        setLink(value);
      })
      .catch((err) => active && setError(describe(err)));
    return () => {
      active = false;
    };
  }, [client, room.id, link, attempt]);

  // Live status: a member who was not here when the sheet opened has joined.
  useEffect(() => {
    let active = true;
    let baseline: Set<string> | null = null;
    const started = Date.now();
    const tick = async () => {
      try {
        const members = await withRoomDeadline(client.members({ room_id: room.id }));
        if (!active) return;
        if (!baseline) baseline = new Set(members.map((member) => member.id));
        else {
          const fresh = members.find((member) => !baseline!.has(member.id));
          if (fresh) {
            setJoined(fresh.name);
            return;
          }
        }
      } catch {
        // Status is best effort; the link itself is what matters.
      }
      if (active && Date.now() - started < MEMBER_POLL_LIMIT_MS)
        timer = window.setTimeout(() => void tick(), MEMBER_POLL_MS);
    };
    let timer = window.setTimeout(() => void tick(), 0);
    const still = window.setTimeout(() => setWaiting('still'), PULSE_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
      window.clearTimeout(still);
    };
  }, [client, room.id]);

  // Focus the dialog, trap Tab inside it, close on Escape.
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement as HTMLElement | null;
    element?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !element) return;
      const focusable = [
        ...element.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, summary, [href], [tabindex="0"]',
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keys);
    return () => {
      document.removeEventListener('keydown', keys);
      previous?.focus?.();
    };
  }, [onClose]);

  async function copy() {
    if (!link) return;
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      // One ready line for the AI (join and stay); the link itself stays visible above.
      await navigator.clipboard.writeText(roomInviteCopyLine(link.url));
      setCopyHint('');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked: select the link so the person can copy it by keyboard.
      dialog.current?.querySelector<HTMLInputElement>('input.rm-link')?.select();
      const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
      setCopyHint(`Press ${mac ? '⌘C' : 'Ctrl+C'} to copy`);
    }
  }
  async function makeNew() {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(
        client.rotate({ room_id: room.id, idempotency_key: rotateKey.current }),
      );
      rotateKey.current = crypto.randomUUID();
      cache.delete(room.id);
      setNotice('The old link no longer works. This is a new one.');
      setConfirmNew(false);
      setLink(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    if (!link) return;
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.revokeJoinLink({ id: link.id }));
      // Only this code stops working; a fresh link replaces it in the sheet.
      cache.delete(room.id);
      setConfirmRevoke(false);
      setNotice('The old link no longer works. This is a new one.');
      setLink(null);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function changeHistory(next: History) {
    const previous = history;
    // Optimistic: the box follows the click; a failure puts it back and says so.
    setHistory(next);
    setHistoryBusy(true);
    setHistoryError('');
    try {
      const updated = await withRoomDeadline(
        client.setHistory({ room_id: room.id, history: next }),
      );
      setHistory(updated.history);
      onRoomChanged?.();
    } catch (err) {
      setHistory(previous);
      setHistoryError(describe(err));
    } finally {
      setHistoryBusy(false);
    }
  }

  const expires = link ? new Date(link.expires_at) : null;
  return (
    <div
      className="rm-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="rm-sheet rm-invite"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rm-invite-title"
        tabIndex={-1}
        ref={dialog}
      >
        <div className="rm-sheet-head">
          <h2 id="rm-invite-title">Invite to this room</h2>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-muted rm-instruction">
          Paste the link into your AI. New AI? <a href="/#connect">Connect your AI</a> first.
        </p>
        {error ? (
          <div className="rm-inline-error" role="alert">
            <span>{link ? error : "The link couldn't be created."}</span>
            {link ? null : (
              <button type="button" className="rm-quiet" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </button>
            )}
          </div>
        ) : null}
        {link ? (
          <>
            <input
              className="rm-link"
              readOnly
              aria-label="Invite link"
              value={link.url}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button type="button" className="rm-primary rm-copy" onClick={() => void copy()}>
              {copied ? (
                <Check size={16} aria-hidden="true" />
              ) : (
                <Copy size={16} aria-hidden="true" />
              )}
              <span>{copied ? 'Copied' : 'Copy invite'}</span>
            </button>
            {notice ? (
              <p className="rm-meta" role="status">
                {notice}
              </p>
            ) : null}
            {copyHint ? (
              <p className="rm-meta" role="status">
                {copyHint}
              </p>
            ) : null}
            <span className="rm-visually-hidden" aria-live="polite">
              {copied ? 'Invite copied' : ''}
            </span>
            {link.code ? (
              <p className="rm-meta">
                People join with the code <strong className="rm-code">{link.code}</strong>
              </p>
            ) : null}
          </>
        ) : error ? null : (
          <p className="rm-muted" role="status">
            <LoaderCircle className="spin" size={14} aria-hidden="true" /> Creating your link…
          </p>
        )}
        <p
          className={`rm-status${joined ? ' done' : waiting === 'pulse' ? ' pulse' : ''}`}
          aria-live="polite"
        >
          {joined ? (
            <>
              <Check size={16} aria-hidden="true" /> {joined} joined
            </>
          ) : waiting === 'pulse' ? (
            'Waiting for your AI…'
          ) : (
            'Still waiting. Paste the link into your AI, then come back.'
          )}
        </p>
        {joined ? (
          <button type="button" className="rm-primary" onClick={onClose}>
            Go to room
          </button>
        ) : null}
        <details className="rm-disclosure">
          <summary>More options</summary>
          <div className="rm-invite-options">
            <label className="rm-check">
              <input
                type="checkbox"
                checked={history === 'full'}
                disabled={historyBusy}
                onChange={(event) =>
                  void changeHistory(event.target.checked ? 'full' : 'from_join')
                }
              />
              <span>New members can read earlier messages</span>
            </label>
            {historyError ? (
              <p className="rm-inline-error" role="alert">
                {historyError}
              </p>
            ) : history === 'full' ? (
              <p className="rm-meta">People and AIs who join can read the whole conversation.</p>
            ) : null}
            <label className="rm-check">
              <input
                type="checkbox"
                checked={people.join}
                onChange={(event) => void changePeople({ ...people, join: event.target.checked })}
              />
              <span>People can join as themselves</span>
            </label>
            <label className="rm-check">
              <input
                type="checkbox"
                checked={people.bringAi}
                onChange={(event) =>
                  void changePeople({ ...people, bringAi: event.target.checked })
                }
              />
              <span>Members can bring their own AI</span>
            </label>
            {peopleError ? (
              <p className="rm-inline-error" role="alert">
                {peopleError}
              </p>
            ) : null}
            {room.member_cap !== undefined ? (
              <form
                className="rm-check"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveCap();
                }}
              >
                {/* The limit comes from the room (the server sets the ceiling per account). */}
                <label>
                  <span>Member limit (people and AIs) </span>
                  <input
                    className="rm-input rm-cap"
                    type="number"
                    inputMode="numeric"
                    min={Math.max(2, room.member_count)}
                    value={cap}
                    onChange={(event) => setCap(event.target.value)}
                  />
                </label>
                <button type="submit" className="rm-quiet">
                  Save
                </button>
                {capNote ? (
                  <span className="rm-meta" role="status">
                    {capNote}
                  </span>
                ) : null}
              </form>
            ) : null}
            {expires ? <p className="rm-meta">Link expires {expires.toLocaleString()}.</p> : null}
            {link ? (
              confirmRevoke ? (
                <div className="rm-confirm">
                  <span className="rm-confirm-text">
                    Anyone holding this link can no longer join with it.
                  </span>
                  <span className="rm-confirm-actions">
                    <button
                      type="button"
                      className="rm-danger"
                      disabled={busy}
                      onClick={() => void revoke()}
                    >
                      Revoke link
                    </button>
                    <button
                      type="button"
                      className="rm-quiet"
                      onClick={() => setConfirmRevoke(false)}
                    >
                      Cancel
                    </button>
                  </span>
                </div>
              ) : (
                <button type="button" className="rm-quiet" onClick={() => setConfirmRevoke(true)}>
                  Revoke this link
                </button>
              )
            ) : null}
            {confirmNew ? (
              <div className="rm-confirm">
                <span className="rm-confirm-text">The old link stops working.</span>
                <span className="rm-confirm-actions">
                  <button
                    type="button"
                    className="rm-danger"
                    disabled={busy}
                    onClick={() => void makeNew()}
                  >
                    {busy ? 'Making a new link…' : 'Make a new link'}
                  </button>
                  <button type="button" className="rm-quiet" onClick={() => setConfirmNew(false)}>
                    Cancel
                  </button>
                </span>
              </div>
            ) : (
              <button type="button" className="rm-quiet" onClick={() => setConfirmNew(true)}>
                Make a new link
              </button>
            )}
            <p className="rm-meta">
              {ROOM_INVITE_CLIENTS} {CHATGPT_ADMIN_NOTE}
            </p>
          </div>
        </details>
        <p className="rm-meta">Anyone with this link can join this room, and nothing else.</p>
      </div>
    </div>
  );
}
