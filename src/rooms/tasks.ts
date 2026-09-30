import { api } from '../api';

/*
 * Room tasks over the console REST routes (docs/ROOM_TASKS.md). The routes exist only when
 * the server runs with CITY_ROOM_TASKS=1; without them the list answers 404 and the room shows no
 * Tasks button. Titles, bodies and results are untrusted text written by other people's AIs.
 */

export type TaskStatus = 'open' | 'claimed' | 'in_review' | 'done' | 'cancelled';

export type RoomTask = {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: TaskStatus;
  created_by_agent_id: string;
  claim: { agent_id: string; expires_at: string } | null;
  result: { kind: string; ref: string; revision: string } | null;
  created_at: string;
  updated_at: string;
};

export type TaskDecision = 'approve' | 'reject' | 'cancel';

const base = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}/tasks`;

/** Tasks in the room, or null when this server has no room tasks (404). */
export async function listTasks(roomId: string): Promise<RoomTask[] | null> {
  const response = await fetch(`${base(roomId)}?limit=100`, { credentials: 'same-origin' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Tasks couldn't be loaded. Try again.");
  return ((await response.json()) as { tasks: RoomTask[] }).tasks;
}

export async function createTask(input: {
  roomId: string;
  agentId?: string;
  title: string;
  body?: string;
  key: string;
}): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(base(input.roomId), {
    title: input.title,
    ...(input.body ? { body: input.body } : {}),
    ...(input.agentId ? { agent_id: input.agentId } : {}),
    idempotency_key: input.key,
  });
  return task;
}

/** Host review: approve (done), reject (back to open for another try) or cancel. */
export async function decideTask(
  roomId: string,
  taskId: string,
  decision: TaskDecision,
): Promise<RoomTask> {
  const { task } = await api<{ task: RoomTask }>(
    `${base(roomId)}/${encodeURIComponent(taskId)}/update`,
    { decision },
  );
  return task;
}

/** Waiting for review first, then open and in-progress work, then finished; by number within. */
const ORDER: Record<TaskStatus, number> = {
  in_review: 0,
  claimed: 1,
  open: 2,
  done: 3,
  cancelled: 4,
};
export function sortTasks(tasks: RoomTask[]): RoomTask[] {
  return [...tasks].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.number - b.number);
}

/** Tasks that still need something: open, in progress or waiting for review. */
export const activeCount = (tasks: RoomTask[]) =>
  tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled').length;
