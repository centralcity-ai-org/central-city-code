import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../api';
import { RoomsError, withRoomDeadline, type Room, type RoomsClient } from './api';
import { describe } from './useRoomThread';

/** One message for every unusable invite, so a code's existence never leaks. */
const INVALID = 'This invite is invalid or has expired. Ask the host for a new one.';

/** A link (https://.../j/..., /r/...#...) or a short code (7K4M-Q9XP); trimmed, code uppercased. */
export function readInvite(input: string): { link: string } | { code: string } | null {
  const value = input.trim();
  if (!value) return null;
  if (/^https?:\/\//i.test(value) || value.startsWith('/')) return { link: value };
  return { code: value.toUpperCase() };
}

/**
 * "Join a room": a signed-in person pastes the invite link or the short code
 * the host shared and joins as themselves, a person in the room. Their AI can join later.
 */
export function JoinRoomSheet({
  client,
  accountName,
  onClose,
  onJoined,
}: {
  client: RoomsClient;
  accountName: string;
  onClose: () => void;
  onJoined: (room: Room) => void;
}) {
  const [invite, setInvite] = useState('');
  const [name, setName] = useState(accountName.slice(0, 40));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus(), []);

  async function join() {
    const parsed = readInvite(invite);
    if (!parsed) return;
    setBusy(true);
    setError('');
    try {
      const room = await withRoomDeadline(
        client.joinAsPerson({ ...parsed, name: name.trim(), idempotency_key: key.current }),
      );
      onJoined(room);
    } catch (err) {
      key.current = crypto.randomUUID();
      if (err instanceof RoomsError && err.code === 'invite_invalid') setError(INVALID);
      else if (err instanceof ApiError && err.status === 400) setError(INVALID);
      else if (err instanceof ApiError && err.status === 403)
        setError(
          "The host doesn't let people join this room as themselves. Your AI can still join with the invite.",
        );
      else setError(describe(err));
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
        aria-labelledby="rm-join-title"
        onSubmit={(event) => {
          event.preventDefault();
          void join();
        }}
      >
        <div className="rm-sheet-head">
          <h2 id="rm-join-title">Join a room</h2>
          <button type="button" className="rm-icon" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
        <p className="rm-muted">
          Paste the invite link or type the code the host gave you. You join as yourself.
        </p>
        <label className="rm-field">
          <span>Invite link or code</span>
          <input
            ref={field}
            className="rm-input"
            value={invite}
            autoComplete="off"
            spellCheck={false}
            placeholder="7K4M-Q9XP"
            onChange={(event) => {
              setInvite(event.target.value);
              setError('');
            }}
          />
        </label>
        <label className="rm-field">
          <span>Your name in the room</span>
          <input
            className="rm-input"
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {error ? (
          <p className="rm-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="rm-actions">
          <button type="submit" className="rm-primary" disabled={busy || !readInvite(invite)}>
            {busy ? 'Joining…' : 'Join room'}
          </button>
          <button type="button" className="rm-quiet" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
