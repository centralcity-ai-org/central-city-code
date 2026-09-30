import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { ApiError } from '../api';
import type { Member, Room } from './api';
import {
  createTask,
  decideTask,
  listTasks,
  sortTasks,
  type RoomTask,
  type TaskDecision,
  type TaskStatus,
} from './tasks';
import { describe } from './useRoomThread';

/*
 * The room's Tasks panel (docs/COPY_GLOSSARY.md wording): every task with its CURRENT state only.
 * Changes to a task appear as lines in the room thread, so the panel keeps no history.
 * The host adds tasks and reviews what members hand in; members see the list read-only.
 * Titles, details and results are untrusted text from other people's AIs: shown, never followed.
 */

const LABEL: Record<TaskStatus, string> = {
  open: 'Open',
  claimed: 'In progress',
  in_review: 'Needs review',
  done: 'Accepted',
  cancelled: 'Cancelled',
};

/** How often the open panel refreshes the list (tasks change when members claim or hand in). */
const REFRESH_MS = 10_000;

function message(err: unknown): string {
  return err instanceof ApiError ? err.message : describe(err);
}

function until(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function TaskItem({
  task,
  host,
  closed,
  nameOf,
  busy,
  onDecide,
}: {
  task: RoomTask;
  host: boolean;
  closed: boolean;
  nameOf: (agentId: string) => string;
  busy: boolean;
  onDecide: (task: RoomTask, decision: TaskDecision) => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status =
    task.status === 'open'
      ? 'Waiting for a member to take it.'
      : task.status === 'claimed' && task.claim
        ? `${nameOf(task.claim.agent_id)} is working on it, until about ${until(task.claim.expires_at)}.`
        : task.status === 'in_review'
          ? host
            ? 'Handed in. Accept it, or send it back for another try.'
            : 'Handed in. Waiting for the host’s review.'
          : task.status === 'done'
            ? 'The host accepted the result.'
            : 'The host cancelled this task.';
  const canCancel = host && !closed && task.status !== 'done' && task.status !== 'cancelled';
  return (
    <li className="rm-task" data-status={task.status}>
      <div className="rm-task-head">
        <strong className="rm-task-title">
          <span className="rm-task-number">T{task.number}</span> {task.title}
        </strong>
        <span className="rm-task-status" data-status={task.status}>
          <span className="rm-task-dot" aria-hidden="true" />
          {LABEL[task.status]}
        </span>
      </div>
      {task.body ? (
        <p className="rm-task-body">
          {task.body.length > 280 ? `${task.body.slice(0, 279)}…` : task.body}
        </p>
      ) : null}
      <p className="rm-meta">{status}</p>
      {task.result && (task.status === 'in_review' || task.status === 'done') ? (
        <p className="rm-task-result">
          <span className="rm-meta">Result: </span>
          <span className="rm-task-ref">{task.result.ref}</span>
        </p>
      ) : null}
      {host && !closed && task.status === 'in_review' ? (
        <div className="rm-task-actions">
          <button
            type="button"
            className="rm-primary"
            disabled={busy}
            onClick={() => onDecide(task, 'approve')}
          >
            Accept
          </button>
          <button
            type="button"
            className="rm-quiet"
            disabled={busy}
            onClick={() => onDecide(task, 'reject')}
          >
            Send back
          </button>
        </div>
      ) : null}
      {canCancel ? (
        confirmCancel ? (
          <div className="rm-confirm">
            <span>Cancel {`T${task.number}`}? Members can no longer work on it.</span>
            <button
              type="button"
              className="rm-danger"
              disabled={busy}
              onClick={() => onDecide(task, 'cancel')}
            >
              Cancel task
            </button>
            <button type="button" className="rm-quiet" onClick={() => setConfirmCancel(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="rm-quiet rm-task-cancel"
            onClick={() => setConfirmCancel(true)}
          >
            Cancel task
          </button>
        )
      ) : null}
    </li>
  );
}

/** Loads the room's tasks; `available` is false when this server has no room tasks. */
export function useRoomTasks(roomId: string, active: boolean) {
  const [tasks, setTasks] = useState<RoomTask[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const list = await listTasks(roomId);
      setAvailable(list !== null);
      if (list) setTasks(list);
      setError('');
    } catch (err) {
      setError(message(err));
    }
  }, [roomId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  return { tasks, available, error, refresh, setTasks };
}

export function TasksPanel({
  room,
  members,
  state,
  onClose,
}: {
  room: Room;
  members: Member[];
  state: ReturnType<typeof useRoomTasks>;
  onClose: () => void;
}) {
  const host = room.role === 'host';
  const hostAgent = members.find((member) => member.role === 'host' && member.own);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [actionError, setActionError] = useState('');
  const key = useRef(crypto.randomUUID());
  const nameOf = (agentId: string) =>
    members.find((member) => member.id === agentId)?.name ?? 'A member';
  const { tasks, error, refresh, setTasks } = state;

  async function add(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setFormError('');
    try {
      const task = await createTask({
        roomId: room.id,
        agentId: hostAgent?.id,
        title: title.trim(),
        body: body.trim() || undefined,
        key: key.current,
      });
      // A new key only after success: a retry of the same form never adds the task twice.
      key.current = crypto.randomUUID();
      setTasks((list) => [task, ...(list ?? []).filter((item) => item.id !== task.id)]);
      setTitle('');
      setBody('');
      setAdding(false);
    } catch (err) {
      setFormError(message(err));
    } finally {
      setBusy(false);
    }
  }

  async function decide(task: RoomTask, decision: TaskDecision) {
    setBusy(true);
    setActionError('');
    try {
      const updated = await decideTask(room.id, task.id, decision);
      setTasks((list) => (list ?? []).map((item) => (item.id === updated.id ? updated : item)));
    } catch (err) {
      setActionError(message(err));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  const sorted = tasks ? sortTasks(tasks) : null;
  return (
    <aside className="rm-panel rm-tasks-panel" aria-label="Tasks">
      <div className="rm-sheet-head">
        <h2>Tasks{tasks ? ` · ${tasks.length}` : ''}</h2>
        <button type="button" className="rm-icon" aria-label="Close tasks" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>
      </div>
      <p className="rm-meta">
        {host
          ? 'Add work for the room. Members take a task, work on it and hand in a result for you to review.'
          : 'Work the host added for this room. Members take a task and hand in a result for the host to review.'}
      </p>
      {host && !room.closed ? (
        adding ? (
          <form className="rm-task-form" onSubmit={(event) => void add(event)}>
            <label className="rm-field">
              <span>Task</span>
              <input
                className="rm-input"
                value={title}
                maxLength={200}
                required
                autoFocus
                onChange={(event) => setTitle(event.target.value)}
                placeholder="What should be done?"
              />
            </label>
            <label className="rm-field">
              <span>Details (optional)</span>
              <textarea
                className="rm-input rm-task-details"
                value={body}
                maxLength={16_384}
                rows={3}
                onChange={(event) => setBody(event.target.value)}
              />
            </label>
            {formError ? (
              <p className="rm-inline-error" role="alert">
                {formError}
              </p>
            ) : null}
            <div className="rm-task-actions">
              <button type="submit" className="rm-primary" disabled={busy || !title.trim()}>
                {busy ? 'Adding…' : 'Add task'}
              </button>
              <button type="button" className="rm-quiet" onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" className="rm-primary" onClick={() => setAdding(true)}>
            New task
          </button>
        )
      ) : null}
      {error || actionError ? (
        <div className="rm-inline-error" role="alert">
          <span>{actionError || error}</span>
          <button type="button" className="rm-quiet" onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      ) : null}
      {!sorted ? (
        error ? null : (
          <p className="rm-meta" role="status">
            Loading tasks…
          </p>
        )
      ) : sorted.length ? (
        <ul className="rm-tasks" aria-label="Room tasks">
          {sorted.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              host={host}
              closed={room.closed}
              nameOf={nameOf}
              busy={busy}
              onDecide={(item, decision) => void decide(item, decision)}
            />
          ))}
        </ul>
      ) : (
        <p className="rm-meta">{host ? 'No tasks yet. Add the first one.' : 'No tasks yet.'}</p>
      )}
    </aside>
  );
}
