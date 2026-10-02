import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ChevronDown, ChevronRight, Settings2, Users, X } from 'lucide-react';
import { ApiError } from '../api';
import { withRoomDeadline, type Member, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';

/** Server limits (docs/ROOM_MANAGEMENT.md). */
const NAME_MAX = 80;
const TOPIC_MAX = 280;

/** What the server stores: whitespace collapsed and trimmed. */
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/**
 * A compact inline confirmation: a short question, a small danger button and a quiet Cancel.
 * It replaces the button that opened it, so Cancel takes focus (the safe choice).
 */
export function ConfirmRow({
  question,
  action,
  solid = false,
  busy,
  onConfirm,
  onCancel,
}: {
  question: string;
  action: string;
  /** The filled red button of the Danger zone (and neutral Cancel) instead of the compact one. */
  solid?: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="rm-confirm" role="group" aria-label={question}>
      <span className="rm-confirm-text">{question}</span>
      <span className="rm-confirm-actions">
        <button
          type="button"
          className={solid ? 'rm-danger rm-danger-solid' : 'rm-danger'}
          disabled={busy}
          onClick={onConfirm}
        >
          {action}
        </button>
        <button
          ref={cancelRef}
          type="button"
          className={solid ? 'rm-secondary' : 'rm-quiet'}
          onClick={onCancel}
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

/** Plain sentences for the room-management refusals; anything else uses the shared copy. */
function settingsError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'invalid_name':
        return 'Give the room a name.';
      case 'credential_in_message':
        return "Names and topics can't contain a password or key. Take it out and try again.";
      case 'room_closed':
        return "This room is closed, so its settings can't change.";
      case 'host_required':
        return 'Only the host can change this.';
      case 'confirm_name_mismatch':
        return "The name doesn't match. Type it exactly as shown.";
      case 'invalid_request':
        return 'Check the name and topic, then try again.';
    }
    if (err.status === 429) return 'Too many attempts. Wait a while, then try again.';
  }
  return describe(err);
}

/** Name and topic (host only). Save stays off until something changed. */
function GeneralSection({
  client,
  room,
  onSaved,
}: {
  client: RoomsClient;
  room: Room;
  onSaved: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(room.name);
  const [topic, setTopic] = useState(room.topic);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nameError, setNameError] = useState('');
  const [toast, setToast] = useState('');
  // The values the form started from: a newer name or topic from the server replaces an
  // untouched field, never one the host is editing.
  const base = useRef({ name: room.name, topic: room.topic });
  useEffect(() => {
    setName((value) => (value === base.current.name ? room.name : value));
    setTopic((value) => (value === base.current.topic ? room.topic : value));
    base.current = { name: room.name, topic: room.topic };
  }, [room.name, room.topic]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const nameChanged = clean(name) !== room.name;
  const topicChanged = clean(topic) !== room.topic;
  const closed = room.closed;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!nameChanged && !topicChanged) return;
    if (!clean(name)) {
      setNameError('Give the room a name.');
      return;
    }
    setBusy(true);
    setError('');
    setNameError('');
    try {
      const result = await withRoomDeadline(
        client.rename({
          room_id: room.id,
          ...(nameChanged ? { name: clean(name) } : {}),
          ...(topicChanged ? { topic: clean(topic) } : {}),
        }),
      );
      base.current = { name: result.room.name, topic: result.room.topic };
      setName(result.room.name);
      setTopic(result.room.topic);
      setToast('Saved');
      onSaved();
    } catch (err) {
      const copy = settingsError(err);
      if (err instanceof ApiError && err.code === 'invalid_name') setNameError(copy);
      else setError(copy);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="rm-settings-section" aria-labelledby={`${id}-general`}>
      <h3 id={`${id}-general`}>General</h3>
      {closed ? (
        <p className="rm-meta">This room is closed. Its name and topic can&apos;t change.</p>
      ) : null}
      <form className="rm-settings-form" onSubmit={(event) => void save(event)} noValidate>
        <label className="rm-field">
          Room name
          <input
            className="rm-input"
            value={name}
            maxLength={NAME_MAX}
            disabled={closed || busy}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${id}-name-error` : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setNameError('');
            }}
          />
        </label>
        {nameError ? (
          <p className="rm-field-error" id={`${id}-name-error`}>
            {nameError}
          </p>
        ) : null}
        <label className="rm-field">
          Topic or rules
          <textarea
            className="rm-input rm-textarea"
            value={topic}
            maxLength={TOPIC_MAX}
            rows={3}
            disabled={closed || busy}
            placeholder="What this room is for"
            onChange={(event) => setTopic(event.target.value)}
          />
        </label>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-settings-actions">
          <button
            type="submit"
            className="rm-primary"
            disabled={closed || busy || (!nameChanged && !topicChanged)}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <span className="rm-toast" role="status">
            {toast}
          </span>
        </div>
      </form>
    </section>
  );
}

/**
 * Host only: networks blocked after the host removed a guest AI (30 days). A quiet row with Clear
 * and a compact confirm; hidden when nothing is blocked.
 */
function GuestBlocks({
  client,
  room,
  onChanged,
}: {
  client: RoomsClient;
  room: Room;
  onChanged: () => void;
}) {
  const count = room.guestBlocks ?? 0;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cleared, setCleared] = useState(false);
  const [toast, setToast] = useState('');
  const clearRef = useRef<HTMLButtonElement>(null);
  // A newer count from the server (after the refresh, or new blocks later) replaces the local hide.
  useEffect(() => setCleared(false), [count]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  async function clear() {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.clearGuestBlocks({ room_id: room.id }));
      setConfirming(false);
      setCleared(true);
      setToast('Blocks cleared');
      onChanged();
    } catch (err) {
      setError(settingsError(err));
    } finally {
      setBusy(false);
    }
  }
  const visible = count > 0 && !cleared;
  if (!visible && !toast) return null;
  return (
    <>
      {visible ? (
        confirming ? (
          <ConfirmRow
            question="Clear blocks?"
            action="Confirm"
            busy={busy}
            onConfirm={() => void clear()}
            onCancel={() => {
              setConfirming(false);
              setError('');
              requestAnimationFrame(() => clearRef.current?.focus());
            }}
          />
        ) : (
          <div className="rm-confirm">
            <div className="rm-confirm-text">
              <div>{count === 1 ? '1 network blocked' : `${count} networks blocked`}</div>
              <p className="rm-meta">
                Guest AIs you removed can&apos;t rejoin from these networks for 30 days.
              </p>
            </div>
            <button
              ref={clearRef}
              type="button"
              className="rm-secondary"
              onClick={() => setConfirming(true)}
            >
              Clear
            </button>
          </div>
        )
      ) : null}
      {error ? (
        <p className="rm-inline-error" role="alert">
          {error}
        </p>
      ) : null}
      <span className="rm-toast" role="status">
        {toast}
      </span>
    </>
  );
}

/** Close room and Delete room (host only), behind a collapsed "Danger zone". */
function DangerZone({
  client,
  room,
  onChanged,
  onDeleted,
}: {
  client: RoomsClient;
  room: Room;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'close' | 'delete' | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const typedRef = useRef<HTMLInputElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (step === 'delete') typedRef.current?.focus();
  }, [step]);
  function cancel() {
    const key = step;
    setStep(null);
    setTyped('');
    setError('');
    requestAnimationFrame(() =>
      zoneRef.current?.querySelector<HTMLElement>(`[data-confirm="${key}"]`)?.focus(),
    );
  }
  async function closeRoom() {
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.close({ room_id: room.id }));
      setStep(null);
      onChanged();
    } catch (err) {
      setError(settingsError(err));
    } finally {
      setBusy(false);
    }
  }
  async function deleteRoom(event: FormEvent) {
    event.preventDefault();
    if (typed !== room.name) return;
    setBusy(true);
    setError('');
    try {
      await withRoomDeadline(client.deleteRoom({ room_id: room.id, confirm_name: typed }));
      onDeleted();
    } catch (err) {
      setError(settingsError(err));
      setBusy(false);
    }
  }
  return (
    <section className="rm-settings-section rm-danger-zone" aria-labelledby={`${id}-danger`}>
      <h3 id={`${id}-danger`}>
        <button
          type="button"
          className="rm-danger-toggle"
          aria-expanded={open}
          aria-controls={`${id}-danger-body`}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronRight size={16} aria-hidden="true" />
          )}
          Danger zone
        </button>
      </h3>
      {open ? (
        <div className="rm-danger-body" id={`${id}-danger-body`} ref={zoneRef}>
          {error ? (
            <p className="rm-inline-error" role="alert">
              {error}
            </p>
          ) : null}
          {room.closed ? null : step === 'close' ? (
            <ConfirmRow
              question="Nobody can post after this. History stays readable."
              action="Confirm close"
              solid
              busy={busy}
              onConfirm={() => void closeRoom()}
              onCancel={cancel}
            />
          ) : (
            <div className="rm-danger-row">
              <span className="rm-meta">End the room. Its history stays readable.</span>
              <button
                type="button"
                className="rm-danger rm-danger-solid"
                data-confirm="close"
                disabled={step === 'delete'}
                onClick={() => setStep('close')}
              >
                Close room
              </button>
            </div>
          )}
          {step === 'delete' ? (
            <form
              className="rm-delete-confirm"
              aria-label="Delete this room"
              onSubmit={(event) => void deleteRoom(event)}
            >
              <p className="rm-delete-note">
                Deletes the room for everyone: messages, tasks and files are erased.
              </p>
              <label className="rm-field">
                <span>
                  Type <strong className="rm-delete-name">{room.name}</strong> to confirm
                </span>
                <input
                  ref={typedRef}
                  className="rm-input"
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label="Room name to confirm"
                  onChange={(event) => setTyped(event.target.value)}
                />
              </label>
              <span className="rm-confirm-actions">
                <button
                  type="submit"
                  className="rm-danger rm-danger-solid"
                  disabled={busy || typed !== room.name}
                >
                  {busy ? 'Deleting…' : 'Delete room'}
                </button>
                <button type="button" className="rm-secondary" onClick={cancel}>
                  Cancel
                </button>
              </span>
            </form>
          ) : (
            <div className="rm-danger-row">
              <span className="rm-meta">Erase the room and everything in it.</span>
              <button
                type="button"
                className="rm-danger rm-danger-solid"
                data-confirm="delete"
                disabled={step === 'close'}
                onClick={() => setStep('delete')}
              >
                Delete room
              </button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Room settings: a right-side panel (a bottom sheet on phones). The host gets General and the
 * Danger zone; everyone gets Members.
 */
export function RoomSettings({
  client,
  room,
  members,
  ready,
  onManageMembers,
  onChanged,
  onDeleted,
  onClose,
}: {
  client: RoomsClient;
  room: Room;
  members: Member[];
  /** False until the room has loaded from the server (its name, topic and role). */
  ready: boolean;
  onManageMembers: () => void;
  onChanged: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const host = room.role === 'host';
  const count = members.length || room.member_count;
  return (
    <aside className="rm-panel rm-settings" aria-label="Room settings">
      <div className="rm-sheet-head">
        <h2>
          <Settings2 size={16} aria-hidden="true" />
          Room settings
        </h2>
        <button type="button" className="rm-icon" aria-label="Close settings" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      {!ready ? (
        <p className="rm-meta" role="status">
          Loading settings…
        </p>
      ) : (
        <>
          {room.closed && !host ? (
            <p className="rm-meta">This room is closed. Its history stays readable.</p>
          ) : null}
          {host ? <GeneralSection client={client} room={room} onSaved={onChanged} /> : null}
          <section className="rm-settings-section" aria-label="Members">
            <h3>Members</h3>
            <button type="button" className="rm-settings-link" onClick={onManageMembers}>
              <Users size={16} aria-hidden="true" />
              Manage members
              <span className="rm-count">{count}</span>
            </button>
            {host ? <GuestBlocks client={client} room={room} onChanged={onChanged} /> : null}
          </section>
          {host ? (
            <DangerZone client={client} room={room} onChanged={onChanged} onDeleted={onDeleted} />
          ) : null}
        </>
      )}
    </aside>
  );
}
