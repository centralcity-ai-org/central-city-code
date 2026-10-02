/**
 * The rooms UI transport contract. The `RoomsClient` shape, the
 * mock and `withRoomDeadline` come from the first rooms UI, extended with
 * `parts`, `own`, `sender_owner_label`, `created_at`, `member_count` and `latest_seq`, and adapted
 * to the live REST routes (docs/ROOMS.md, docs/JOIN_LINKS.md).
 *
 * Every call goes through api(), which keeps X-City-Workspace. Server text is never shown: errors
 * surface as RoomsError (a code for the UI) or ApiError (status only) and are described with
 * describeError. Invite secrets travel only in request bodies, never in a URL.
 */
import { api, ApiError } from '../api';
import type { MessagePart } from '../../server/messaging/contract';

export type Agent = { id: string; name: string };
export type Role = 'host' | 'member' | 'guest';
export type MessageFormat = 'plain' | 'markdown';
/** A member that left on its own (host view). */
export type LeftMember = { id: string; name: string; owner_label: string; left_at: string };
/** A member the host muted (active or left): it still reads, but cannot post. */
export type MutedMember = {
  agent_id: string;
  muted_at: string;
  reason: string | null;
  active: boolean;
};
/** Older servers send no format: that is plain text. */
const withFormat = (message: RoomMessage): RoomMessage => ({
  ...message,
  format: message.format === 'markdown' ? 'markdown' : 'plain',
});
/** 'full': people and AIs who join read the whole conversation; 'from_join': only later messages. */
export type History = 'from_join' | 'full';
/** Server-derived member status (docs/MEMBER_STATUS.md); never reported by the member itself. */
export type MemberStatus = 'active' | 'idle' | 'offline' | 'access_expired';
export type Member = Agent & {
  /** 'person': a signed-in person in the room as themselves. */
  kind?: 'agent' | 'person';
  role: Role;
  owner_label: string;
  own: boolean;
  joined_at: string;
  /** Absent from older servers and the mock. */
  status?: MemberStatus;
  /** Last room activity (minute precision); null unless you host the room or own the member. */
  last_active_at?: string | null;
  /**
   * True for a guest without an account (joined through an invite link); such a guest gets a new
   * identity on every join. Absent from servers that don't mark guests yet: treated as false.
   */
  guest?: boolean;
  /** Server-stamped auto-reply metadata (e.g. { provider: 'elric' }). */
  auto_reply?: { provider: 'openai' | 'anthropic' | 'elric'; label?: string } | null;
};
export type RoomMessage = {
  id: string;
  seq: number;
  origin: 'external';
  /** The sender's name at post time: a label; sender_agent_id is the identity. */
  sender: string;
  sender_agent_id: string;
  sender_owner_label: string;
  own: boolean;
  text: string;
  parts: MessagePart[];
  created_at: string;
  /** How to render text: 'markdown' for new posts once migration 22 lands, else 'plain'. */
  format?: MessageFormat;
  /** An @mention of one of your agents, recorded at post time (AI reads only). */
  mentions_you?: boolean;
  /** 'person': a person in the room wrote it themselves. */
  sender_kind?: 'agent' | 'person';
  /** Server-stamped auto-reply metadata. */
  auto_reply?: {
    provider: 'openai' | 'anthropic' | 'elric';
    model?: string;
    label?: string;
    pending_id?: string;
  } | null;
  /** Ephemeral notice from the server (returned on post, never saved in room history). */
  elric_notice?: ElricNotice;
};
export type Room = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  role: Role;
  closed: boolean;
  readOnly: boolean;
  history: History;
  member_count: number;
  /** Maximum active members, host included (people and AIs share it). */
  member_cap?: number;
  latest_seq: number;
  created_at: string;
  /** Host only: people may join as themselves; members may bring their own AI. */
  peopleMayJoin?: boolean;
  membersMayBringAi?: boolean;
  /** Host only: networks blocked for 30 days after the host removed a guest AI from them. */
  guestBlocks?: number;
  /** Whether the viewer muted notifications for this room (migration 38). */
  notificationsMuted?: boolean;
  /** Host switch: whether AI auto-replies / responders are allowed in this room. */
  respondersAllowed?: boolean;
};
export type ReadPage = {
  room: Room;
  messages: RoomMessage[];
  latest_seq: number;
  visible_from_seq: number;
  next_since: number;
  has_more: boolean;
};
/** A join link, with its short code (7K4M-Q9XP) for the same invite when the server gives one. */
export type JoinLink = { url: string; expires_at: string; id: string; code?: string };

/**
 * 'removed': the host removed the caller's owner; `reason` is the host's own words (untrusted:
 * show it as plain text only) and `mayRejoin` whether a live link lets it back in.
 * 'deleted': the host deleted the room.
 */
export class RoomsError extends Error {
  constructor(
    public code:
      | 'invite_invalid'
      | 'access_denied'
      | 'timeout'
      | 'removed'
      | 'deleted'
      | 'muted'
      | 'member_gone',
    public removal?: { reason: string | null; mayRejoin: boolean },
    /** For 'muted': the host's reason (their words; render as plain text only). */
    public muteReason?: string | null,
  ) {
    super(code);
  }
}

export interface RoomsClient {
  listRooms(): Promise<Room[]>;
  listAgents(): Promise<Agent[]>;
  /** A new agent in the viewer's workspace (hosted: no runtime credential is issued). */
  createAgent(input: { name: string }): Promise<Agent>;
  create(input: {
    agent_id: string;
    name: string;
    idempotency_key: string;
    /** Server default: 'full'. */
    history?: History;
  }): Promise<Room>;
  join(input: {
    room_id: string;
    token?: string;
    idempotency_key: string;
    /** Exactly one: an existing agent, or a new agent created and joined atomically. */
    agent_id?: string;
    create?: { name: string };
  }): Promise<Room>;
  /** The signed-in person joins as themselves with a pasted link or a short code. */
  joinAsPerson(input: {
    link?: string;
    code?: string;
    name: string;
    idempotency_key: string;
  }): Promise<Room>;
  /** Host: whether people may join as themselves and bring their own AI. */
  setPeople(input: {
    room_id: string;
    people_may_join?: boolean;
    members_may_bring_ai?: boolean;
  }): Promise<Room>;
  /** Messages with seq > since (server-clamped to the caller's visible history), oldest first. */
  read(input: { room_id: string; since?: number; limit?: number }): Promise<ReadPage>;
  members(input: { room_id: string }): Promise<Member[]>;
  post(input: {
    room_id: string;
    text: string;
    agent_id?: string;
    idempotency_key: string;
  }): Promise<RoomMessage>;
  /** A universal join link (/j/<code>) wrapping the room's invite. Host only. */
  joinLink(input: { room_id: string }): Promise<JoinLink>;
  /** Revoke one join link (`POST /api/links/:id/revoke`); other links keep working. */
  revokeJoinLink(input: { id: string }): Promise<void>;
  /** Rotate the room invite: every earlier link, and every join link wrapping one, stops. */
  rotate(input: { room_id: string; idempotency_key: string }): Promise<void>;
  /**
   * Host only. `reason` (at most 200 characters) is shown only to the removed member;
   * `block_rejoin` (server default true) keeps its owner from joining again.
   */
  remove(input: {
    room_id: string;
    agent_id: string;
    reason?: string;
    block_rejoin?: boolean;
  }): Promise<void>;
  /** Host only: the room's name and/or topic (`PATCH /api/rooms/:room`). */
  rename(input: {
    room_id: string;
    name?: string;
    topic?: string;
  }): Promise<{ room: Room; changed: boolean }>;
  /** Host only: deletes the room for everyone; `confirm_name` must equal its name exactly. */
  deleteRoom(input: { room_id: string; confirm_name: string }): Promise<void>;
  close(input: { room_id: string }): Promise<void>;
  /** Your member agent leaves (not the host); agent_id when you have several there. */
  leave(input: { room_id: string; agent_id?: string }): Promise<void>;
  /** Host only: members that left on their own recently (listed only). */
  recentlyLeft(input: { room_id: string }): Promise<LeftMember[]>;
  /**
   * Host only: mute or unmute one member (`POST /api/rooms/:room/mute`). A muted member still
   * reads but cannot post; `reason` (at most 200 characters) is shown only to the muted member.
   */
  mute(input: {
    room_id: string;
    agent_id: string;
    muted: boolean;
    reason?: string;
  }): Promise<void>;
  /** Host only: the room's muted members (`GET /api/rooms/:room/mutes`). */
  mutes(input: { room_id: string }): Promise<MutedMember[]>;
  /** Host only: who reads earlier messages (`POST /api/rooms/:room/settings`). */
  setHistory(input: { room_id: string; history: History }): Promise<Room>;
  /** Host only: the member cap, from max(current members, 2) to 100. */
  setMemberCap(input: { room_id: string; member_cap: number }): Promise<Room>;
  /** Host only: lift the room's guest network blocks (`DELETE /api/rooms/:room/guest-blocks`). */
  clearGuestBlocks(input: { room_id: string }): Promise<{ cleared: number }>;
  /** Any member: mute or unmute this room's notifications for yourself. */
  muteNotifications(input: {
    room_id: string;
    muted: boolean;
  }): Promise<{ room_id: string; notifications_muted: boolean }>;
}

/** Bounds waiting, not server execution; retry mutations with their retained keys. */
export function withRoomDeadline<T>(operation: Promise<T>, ms = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new RoomsError('timeout')), ms);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

type ServerRoom = {
  id: string;
  slug: string;
  name: string;
  topic: string;
  role: Role;
  closed: boolean;
  read_only: boolean;
  history: History;
  member_count: number;
  member_cap?: number;
  latest_seq: number;
  created_at: string;
  people_may_join?: boolean;
  members_may_bring_ai?: boolean;
  guest_blocks?: number;
  notifications_muted?: boolean;
  responders_allowed?: boolean;
};
const room = (value: ServerRoom): Room => ({
  id: value.id,
  slug: value.slug,
  name: value.name,
  topic: value.topic,
  role: value.role,
  closed: value.closed,
  readOnly: value.read_only,
  history: value.history,
  member_count: value.member_count,
  ...(value.member_cap === undefined ? {} : { member_cap: value.member_cap }),
  latest_seq: value.latest_seq,
  created_at: value.created_at,
  ...(value.people_may_join === undefined
    ? {}
    : {
        peopleMayJoin: value.people_may_join,
        membersMayBringAi: value.members_may_bring_ai !== false,
      }),
  ...(typeof value.guest_blocks === 'number' ? { guestBlocks: value.guest_blocks } : {}),
  ...(value.notifications_muted === undefined
    ? {}
    : {
        notificationsMuted: value.notifications_muted,
      }),
  ...(value.responders_allowed !== undefined
    ? {
        respondersAllowed: value.responders_allowed !== false,
      }
    : {
        respondersAllowed: true,
      }),
});
const path = (roomId: string) => `/api/rooms/${encodeURIComponent(roomId)}`;
const get = <T>(url: string) => api<T>(url, undefined, 'GET');

/** Maps statuses to UI codes; the server's text is dropped (it is never shown). */
function mapped<T>(operation: Promise<T>, joining = false): Promise<T> {
  return operation.catch((error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 410 && error.code === 'room_deleted') throw new RoomsError('deleted');
      if (error.status === 403 && error.code === 'removed_from_room') {
        const details = (error.details ?? {}) as { reason?: unknown; may_rejoin?: unknown };
        throw new RoomsError('removed', {
          reason: typeof details.reason === 'string' && details.reason ? details.reason : null,
          mayRejoin: details.may_rejoin === true,
        });
      }
      if (error.status === 403 && error.code === 'muted_in_room') {
        const details = (error.details ?? {}) as { reason?: unknown };
        const reason = typeof details.reason === 'string' && details.reason ? details.reason : null;
        throw new RoomsError('muted', undefined, reason);
      }
      if (error.status === 404 && error.code === 'member_not_found')
        throw new RoomsError('member_gone');
      // A join answers 404 for an unknown, expired, rotated or used-up invite.
      if (joining && error.status === 404) throw new RoomsError('invite_invalid');
      if (!joining && error.status === 404) throw new RoomsError('access_denied');
    }
    throw error;
  });
}

/** The live transport over the console REST routes. */
export function createHttpRoomsClient(): RoomsClient {
  const client: RoomsClient = {
    async listRooms() {
      return (await get<{ rooms: ServerRoom[] }>('/api/rooms')).rooms.map(room);
    },
    async listAgents() {
      const snapshot = await get<{
        agents: Array<Agent & { status?: string; revokedAt?: string | null }>;
      }>('/api/snapshot');
      // Never offer the owner's Elric as an identity to act as (host, join as, post as).
      const elric = (await getElricStatus())?.agent_id ?? null;
      return snapshot.agents
        .filter((agent) => !agent.revokedAt && agent.status !== 'revoked' && agent.id !== elric)
        .map(({ id, name }) => ({ id, name }));
    },
    async createAgent({ name }) {
      const { agent } = await api<{ agent: Agent }>('/api/agents', {
        name,
        capability: 'research',
        mode: 'hosted',
      });
      return { id: agent.id, name: agent.name };
    },
    async create(input) {
      return room((await api<{ room: ServerRoom }>('/api/rooms', input)).room);
    },
    async join({ room_id, ...body }) {
      // Only a join with an invite (token) can fail as an invalid invite; adding your own AI by
      // room id (no invite) answers 404 as "not available", never the invite copy.
      const withInvite = Boolean((body as { token?: unknown }).token);
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/join`, body), withInvite)).room,
      );
    },
    async read({ room_id, since, limit }) {
      const query = new URLSearchParams();
      if (since !== undefined) query.set('since', String(Math.max(0, since)));
      if (limit !== undefined) query.set('limit', String(limit));
      const page = await mapped(
        get<Omit<ReadPage, 'room'> & { room: ServerRoom }>(`${path(room_id)}/messages?${query}`),
      );
      return { ...page, messages: page.messages.map(withFormat), room: room(page.room) };
    },
    async members({ room_id }) {
      return (await mapped(get<{ members: Member[] }>(`${path(room_id)}/members`))).members;
    },
    async post({ room_id, ...body }) {
      const response = await mapped(
        api<{ message: RoomMessage; elric_notice?: ElricNotice }>(
          `${path(room_id)}/messages`,
          body,
        ),
      );
      const msg = withFormat(response.message);
      if (response.elric_notice) {
        msg.elric_notice = response.elric_notice;
      }
      return msg;
    },
    async joinLink({ room_id }) {
      const value = await mapped(api<JoinLink>('/api/links', { target: 'room', room_id }));
      return {
        url: value.url,
        expires_at: value.expires_at,
        id: value.id,
        ...(value.code ? { code: value.code } : {}),
      };
    },
    async revokeJoinLink({ id }) {
      await mapped(api(`/api/links/${encodeURIComponent(id)}/revoke`, {}));
    },
    async rotate({ room_id, idempotency_key }) {
      await mapped(api(`${path(room_id)}/link/rotate`, { idempotency_key }));
    },
    async remove({ room_id, agent_id, reason, block_rejoin }) {
      await mapped(
        api(`${path(room_id)}/members/${encodeURIComponent(agent_id)}/remove`, {
          ...(reason ? { reason } : {}),
          ...(block_rejoin === undefined ? {} : { block_rejoin }),
        }),
      );
    },
    async rename({ room_id, ...body }) {
      const value = await mapped(
        api<{ room: ServerRoom; changed: boolean }>(path(room_id), body, 'PATCH'),
      );
      return { room: room(value.room), changed: value.changed };
    },
    async deleteRoom({ room_id, confirm_name }) {
      await mapped(api(path(room_id), { confirm_name }, 'DELETE'));
    },
    async close({ room_id }) {
      await mapped(api(`${path(room_id)}/close`, {}));
    },
    async joinAsPerson(input) {
      return room((await mapped(api<{ room: ServerRoom }>('/api/rooms/join', input), true)).room);
    },
    async setPeople({ room_id, ...body }) {
      return room((await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/people`, body))).room);
    },
    async recentlyLeft({ room_id }) {
      return (await mapped(get<{ left: LeftMember[] }>(`${path(room_id)}/left`))).left;
    },
    async mute({ room_id, agent_id, muted, reason }) {
      await mapped(
        api(`${path(room_id)}/mute`, { agent_id, muted, ...(reason ? { reason } : {}) }),
      );
    },
    async mutes({ room_id }) {
      return (await mapped(get<{ muted: MutedMember[] }>(`${path(room_id)}/mutes`))).muted;
    },
    async leave({ room_id, agent_id }) {
      await mapped(api(`${path(room_id)}/leave`, agent_id ? { agent_id } : {}));
    },
    async setMemberCap({ room_id, member_cap }) {
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/settings`, { member_cap }))).room,
      );
    },
    async setHistory({ room_id, history }) {
      return room(
        (await mapped(api<{ room: ServerRoom }>(`${path(room_id)}/settings`, { history }))).room,
      );
    },
    async clearGuestBlocks({ room_id }) {
      const value = await mapped(
        api<{ room_id: string; cleared: number }>(`${path(room_id)}/guest-blocks`, {}, 'DELETE'),
      );
      return { cleared: value.cleared };
    },
    async muteNotifications({ room_id, muted }) {
      return muteRoomNotifications({ room_id, muted });
    },
  };
  return client;
}

/**
 * Any member, for their own owner: mute or unmute this room's notifications
 * (`POST /api/rooms/:room/notifications`). Posts still wake other members.
 */
export async function muteRoomNotifications(input: {
  room_id: string;
  muted: boolean;
}): Promise<{ room_id: string; notifications_muted: boolean }> {
  return api<{ room_id: string; notifications_muted: boolean }>(
    `/api/rooms/${encodeURIComponent(input.room_id)}/notifications`,
    { muted: input.muted },
  );
}

export type ElricNotice =
  | { code: 'elric_limit'; kind: 'short' | 'summary' | 'tool'; text: string; resets_at: string }
  | { code: 'elric_owner_only'; text: string }
  | { code: string; text: string; kind?: string; resets_at?: string };

export type ElricStatus = {
  agent_id: string | null;
  status: 'active' | 'paused' | 'revoked' | null;
  host_may_invoke: boolean;
  eligible: boolean;
  /** Why not eligible (null when eligible); absent from older servers. */
  eligibility_reason?:
    'unknown' | 'not_person' | 'unverified' | 'age_under_18' | 'age_unknown' | null;
  over_18?: boolean;
  usage: {
    allowance: { short: number; summary: number; tool: number };
    used: { short: number; summary: number; tool: number };
    resets_at: string;
  };
  limit_notices: string[];
};

/**
 * Gets Elric status for the signed-in owner (GET /api/elric).
 * Returns null if the feature flag CITY_ELRIC is off (404), or if unauthorized.
 */
export async function getElricStatus(): Promise<ElricStatus | null> {
  try {
    const status = await api<ElricStatus>('/api/elric', undefined, 'GET');
    // The server answers `eligible` only for a verified adult (the age check passed), so a saved
    // date of birth is never asked again ("Add Elric" a second time).
    return { ...status, over_18: status.over_18 ?? (status.eligible ? true : undefined) };
  } catch {
    return null;
  }
}

/**
 * Submits date of birth for age verification (POST /api/elric/age).
 * Contract: { date_of_birth } -> { age_check: 'over_18' } | 403 elric_age_under_18 | 400 invalid_date_of_birth.
 */
export async function submitElricAge(dateOfBirth: string): Promise<{ age_check: 'over_18' }> {
  return api<{ age_check: 'over_18' }>('/api/elric/age', {
    date_of_birth: dateOfBirth,
  });
}

/**
 * Ensures the owner has an Elric agent created (POST /api/elric).
 * Accepts only { name } and rejects extra fields.
 */
export async function ensureElricAgent(
  name = 'Elric',
): Promise<{ agent_id: string; created: boolean }> {
  return api<{ agent_id: string; created: boolean }>('/api/elric', {
    name,
  });
}

/**
 * Adds Elric to a room: if date of birth is supplied, verifies age first via POST /api/elric/age,
 * then ensures the agent exists via POST /api/elric, then joins it to the room.
 */
export async function addElricToRoom(
  client: RoomsClient,
  roomId: string,
  dateOfBirth?: string,
): Promise<{ agent_id: string }> {
  if (dateOfBirth) {
    await submitElricAge(dateOfBirth);
  }
  const { agent_id } = await ensureElricAgent('Elric');
  await client.join({
    room_id: roomId,
    agent_id,
    idempotency_key: crypto.randomUUID(),
  });
  return { agent_id };
}
