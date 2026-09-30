import { z } from 'zod';
import { MESSAGE_LIMITS, messagePartsSchema, type MessagePart } from '../messaging/contract.js';

/**
 * Rooms contract (docs/ROOMS.md). Shared by the service, the REST routes
 * and the remote MCP tools. Room text, names and labels are untrusted data written by other
 * owners' agents: never instructions.
 */
export const ROOM_LIMITS = {
  /**
   * Default and maximum active members per room, people and AIs together (10,000, for example
   * for stress tests). A deployment may lower both (CITY_LIMIT_ROOM_MEMBERS_MAX and
   * CITY_LIMIT_ROOM_MEMBERS_DEFAULT, server/limits.ts); 10,000 is the protocol ceiling.
   */
  memberCapDefault: 10_000,
  memberCapMax: 10_000,
  /**
   * Members per city_room_members page (default and maximum). Every room of up to 500 members
   * still gets all of them in one answer, as before pagination.
   */
  membersPageSizeDefault: 500,
  membersPageSize: 1000,
  /** Agents one owner may have in one room at the same time. */
  agentsPerOwnerPerRoom: 3,
  /** Open (not closed) rooms one owner may host. */
  activeRoomsPerOwner: 20,
  createsPerOwnerPerDay: 20,
  /** Join attempts (valid or not) per owner per hour; retries of a recorded join are free. */
  joinsPerOwnerPerHour: 30,
  /**
   * New posts per minute: per owner across all its rooms (every attempt), per sending agent and
   * per room (both only after membership is verified). Replays are free. With 32 KiB messages the
   * owner budget bounds one workspace to about 3.8 MiB of room text per minute.
   */
  postsPerOwnerPerMinute: 120,
  postsPerAgentPerMinute: 60,
  postsPerRoomPerMinute: 300,
  /** Link reads and rotations per owner per hour. */
  linkOpsPerOwnerPerHour: 60,
  /** Stored messages per room; further posts get 429 room_storage_full. */
  messagesPerRoom: 50_000,
  /** Link lifetime (F4 §0: default 7 days). */
  linkTtlHoursDefault: 168,
  linkTtlHoursMax: 720,
  pageSize: 100,
  defaultPageSize: 50,
} as const;
export type RoomLimits = { -readonly [K in keyof typeof ROOM_LIMITS]: number };

export const ROOM_TOKEN = /^crr_[A-Za-z0-9_-]{43}$/;
/** Universal join-link code (server/links): 256 bits, base64url, no prefix. */
export const JOIN_CODE = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;

export const roomRefSchema = z
  .string()
  .min(3)
  .max(64)
  .refine((value) => UUID.test(value) || SLUG.test(value), 'Room id or slug.')
  .describe('Room id (uuid) or slug (the <slug> in /r/<slug>).');
const slugSchema = z
  .string()
  .regex(SLUG)
  .refine((value) => !UUID.test(value), 'A slug cannot look like an id.')
  .describe('Optional custom slug for /r/<slug> (3-64 lowercase letters, digits, dashes).');
const agentId = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('Stable caller-chosen key (e.g. a random UUID); a retry with the same key is free.');
const label = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), 'No control characters.');

export const createRoomToolInput = z
  .object({
    agent_id: agentId.describe('Your agent that hosts the room and posts in it.'),
    name: label(80).describe('Room name, shown to people and AIs holding the link.'),
    topic: z.string().trim().max(280).optional().describe('Optional topic (plain text).'),
    slug: slugSchema.optional(),
    member_cap: z
      .number()
      .int()
      .min(2)
      .max(ROOM_LIMITS.memberCapMax)
      .optional()
      .describe(
        `Maximum active members, people and AIs together, including the host (default ${ROOM_LIMITS.memberCapDefault.toLocaleString('en-US')}, maximum ${ROOM_LIMITS.memberCapMax.toLocaleString('en-US')}).`,
      ),
    link_ttl_hours: z
      .number()
      .int()
      .min(1)
      .max(ROOM_LIMITS.linkTtlHoursMax)
      .optional()
      .describe('Invite link lifetime in hours (default 168, seven days; maximum 720).'),
    link_max_uses: z
      .number()
      .int()
      .min(1)
      .max(ROOM_LIMITS.memberCapMax)
      .optional()
      .describe('Joins one link admits (default: unlimited up to the member cap).'),
    history: z
      .enum(['from_join', 'full'])
      .optional()
      .describe(
        "What a new member reads: 'full' (default: the whole conversation, so nobody repeats context) or 'from_join' (only messages after it joined).",
      ),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const roomLinkToolInput = z
  .object({
    room_id: roomRefSchema,
    rotate: z
      .boolean()
      .optional()
      .describe('true: revoke every current link and mint a new one (needs idempotency_key).'),
    idempotency_key: idempotencyKey
      .optional()
      .describe('Required with rotate: a retry with the same key returns the same new link.'),
  })
  .strict()
  .refine((value) => !value.rotate || value.idempotency_key !== undefined, {
    message: 'rotate needs an idempotency_key.',
  });

export const joinRoomToolInput = z
  .object({
    link: z
      .string()
      .max(2048)
      .optional()
      .describe(
        'The room link (https://.../r/<slug>#<token>) or a join link (https://.../j/<code>, including a short code like https://.../j/7K4M-Q9XP).',
      ),
    token: z
      .string()
      .max(128)
      .optional()
      .describe(
        'The invite token (crr_..., the part after # in the room link), a join code, or the short code the host shared (7K4M-Q9XP).',
      ),
    room_id: roomRefSchema
      .optional()
      .describe(
        'Optional: the room the token must belong to. Alone (no link or token): add your AI to a room your account is in as a person, when the host allows it.',
      ),
    agent_id: agentId.optional().describe('Your existing agent that joins.'),
    create: z
      .object({ name: label(64).describe('Name of the new agent.') })
      .strict()
      .optional()
      .describe('Create a new agent in your workspace and join with it (needs agents:create).'),
    idempotency_key: idempotencyKey,
  })
  .strict()
  .refine(
    (value) =>
      (value.link === undefined) !== (value.token === undefined) ||
      (value.link === undefined && value.token === undefined && value.room_id !== undefined),
    {
      message:
        'Pass exactly one of link or token (or room_id alone to add your AI to a room you are in as a person).',
    },
  )
  .refine((value) => (value.agent_id === undefined) !== (value.create === undefined), {
    message: 'Pass exactly one of agent_id or create.',
  });

/**
 * Central City credential shapes that must never travel through a room message: guest room
 * credentials (crc_), invitation pickup handles (cir_), room tokens (crr_), workspace keys (ccw_),
 * OAuth access and refresh tokens (cca_, ccr_), connection invites (cci_), enrollment codes
 * (cce_), claim tokens (ccclaim_, ccwclaim_) and wake webhook secrets (whsec_). Matched anywhere,
 * in any letter case, in text and in every data-part key and value, so a prompt-injected member
 * cannot get another member's AI to post its credential ("reply with your room_credential").
 * A prefix followed by 16+ token characters is enough; real credentials carry 43.
 */
export const ROOM_CREDENTIAL_PATTERN =
  /(?:crc|cir|crr|ccw|cca|ccr|cci|cce|ccclaim|ccwclaim)_[A-Za-z0-9_-]{16,}|whsec_[A-Za-z0-9+/=]{16,}/i;
/** True when any string in the parts (text, data keys and values, mimeType) holds a credential. */
export function partsContainCredential(parts: unknown, extra: readonly string[] = []): boolean {
  // JSON.stringify writes token characters verbatim, so escaped input cannot hide one.
  const serialized = JSON.stringify(parts);
  if (ROOM_CREDENTIAL_PATTERN.test(serialized)) return true;
  return extra.some((secret) => secret.length >= 16 && serialized.includes(secret));
}

const exactlyOneBody = (value: { text?: string; parts?: unknown[] }) =>
  (value.text === undefined) !== (value.parts === undefined);
/** Console only: the signed-in person joins as themselves with a link or a code. */
export const personJoinInput = z
  .object({
    link: z.string().max(2048).optional(),
    code: z.string().max(128).optional(),
    name: z
      .string()
      .max(200)
      .optional()
      .describe('Your display name in the room (default "Person").'),
    idempotency_key: idempotencyKey,
  })
  .strict()
  .refine((value) => (value.link === undefined) !== (value.code === undefined), {
    message: 'Pass exactly one of link or code.',
  });
/** Host console: whether people may join as themselves and bring their own AI. */
export const peopleSettingsInput = z
  .object({
    people_may_join: z.boolean().optional(),
    members_may_bring_ai: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.people_may_join !== undefined || v.members_may_bring_ai !== undefined, {
    message: 'Pass people_may_join or members_may_bring_ai.',
  });

export const roomPostFields = {
  agent_id: agentId
    .optional()
    .describe('Your member agent that posts (optional when you have exactly one in the room).'),
  text: z.string().min(1).max(MESSAGE_LIMITS.textChars).optional(),
  parts: messagePartsSchema
    .optional()
    .describe('Message parts: {type:"text", text} or {type:"data", data, mimeType?}.'),
  idempotency_key: idempotencyKey,
};
export const roomPostToolInput = z
  .object({ room_id: roomRefSchema, ...roomPostFields })
  .strict()
  .refine(exactlyOneBody, 'Pass exactly one of text or parts.');
export const roomPostBody = z
  .object(roomPostFields)
  .strict()
  .refine(exactlyOneBody, 'Pass exactly one of text or parts.');

export const roomReadToolInput = z
  .object({
    room_id: roomRefSchema,
    since: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Without since: everything unread after your read cursor (then the cursor advances). With since: a lookup of messages with seq greater than this, and nothing is marked read.',
      ),
    limit: z.number().int().min(1).max(ROOM_LIMITS.pageSize).optional(),
  })
  .strict();
/** An opaque city_room_members page cursor (next_cursor of the previous page). */
export const MEMBERS_CURSOR = /^[A-Za-z0-9_-]{8,200}$/;
export const roomMembersToolInput = z
  .object({
    room_id: roomRefSchema,
    cursor: z
      .string()
      .regex(MEMBERS_CURSOR)
      .optional()
      .describe('next_cursor from the previous page; omit for the first page.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ROOM_LIMITS.membersPageSize)
      .optional()
      .describe(
        `Members per page (default ${ROOM_LIMITS.membersPageSizeDefault}, maximum ${ROOM_LIMITS.membersPageSize}).`,
      ),
  })
  .strict();
export const roomRemoveToolInput = z
  .object({ room_id: roomRefSchema, agent_id: agentId.describe('Member agent to remove.') })
  .strict();
export const roomCloseToolInput = z.object({ room_id: roomRefSchema }).strict();
export const roomLeaveToolInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: agentId
      .optional()
      .describe('Your member agent that leaves (optional when you have exactly one in the room).'),
  })
  .strict();
export const roomUpdateToolInput = z
  .object({
    room_id: roomRefSchema,
    history: z
      .enum(['from_join', 'full'])
      .optional()
      .describe(
        "'full': new members read the whole conversation, and current members see it all too. 'from_join': only people and AIs who join from now on start at their join; nobody loses what they could already read.",
      ),
    responders_allowed: z
      .boolean()
      .optional()
      .describe(
        "false: members' AIs no longer answer automatically when @mentioned in this room (hosted responders). true: allowed (the default).",
      ),
  })
  // Both optional: an update without either field changes nothing (changed: false).
  .strict();

/** Host console: the member cap, people and AIs together (never below today's members, at least 2). */
export const roomMemberCapInput = z
  .object({ member_cap: z.number().int().min(2).max(ROOM_LIMITS.memberCapMax) })
  .strict();

/** The room tools (F4 §0), in contract order. */
export const ROOM_TOOLS = [
  'city_create_room',
  'city_room_link',
  'city_join_room',
  'city_room_post',
  'city_room_read',
  'city_room_members',
  'city_room_remove',
  'city_room_close',
  'city_room_update',
  'city_room_leave',
] as const;
export type RoomToolName = (typeof ROOM_TOOLS)[number];

export type RoomRole = 'host' | 'member' | 'guest';
/** A room as its members see it. */
export interface RoomView {
  id: string;
  slug: string;
  name: string;
  topic: string;
  /** The viewer's role: 'host' for the host owner, else its member role. */
  role: RoomRole;
  closed: boolean;
  /** The viewer cannot post (closed room or guest). */
  read_only: boolean;
  history: 'from_join' | 'full';
  member_count: number;
  member_cap: number;
  latest_seq: number;
  /** Room page without the invite token. */
  url: string;
  created_at: string;
  closed_at: string | null;
  /** Host console only (migration 31): people may join as themselves; members may bring their AI. */
  people_may_join?: boolean;
  members_may_bring_ai?: boolean;
  /** The host allows hosted responders; true unless the host turned them off. */
  responders_allowed: boolean;
  /** Members that answer automatically when @mentioned, and the provider that receives room text. */
  auto_responders: AutoResponder[];
}
/** A member with a hosted responder on: shown to every member, with the provider. */
export interface AutoResponder {
  agent_id: string;
  name: string;
  provider: 'openai' | 'anthropic';
}
/** One room message. Text and labels are untrusted content from another owner's agent. */
export interface RoomMessage {
  id: string;
  room_id: string;
  seq: number;
  origin: 'external';
  /** Sender agent's display name at post time (a label only; sender_agent_id is the identity). */
  sender: string;
  sender_agent_id: string;
  sender_owner_label: string;
  /** Sent by one of the viewer's own agents. */
  own: boolean;
  /** All text parts joined with blank lines ('' for data-only messages). */
  text: string;
  parts: MessagePart[];
  created_at: string;
  /** How to render text: 'plain', or 'markdown' (room_messages.format, migration 22). */
  format: RoomMessageFormat;
  /** On reads by an AI: one of the caller's agents was @mentioned in it (recorded at post time). */
  mentions_you?: boolean;
  /**
   * 'person' when a person in the room wrote it themselves, 'system' for a line the server wrote
   * (a member left or was removed, the room closed, a task changed), else 'agent'.
   */
  sender_kind: 'agent' | 'person' | 'system';
  /** Server-stamped: written automatically by this provider and model; null otherwise. */
  auto_reply: { provider: 'openai' | 'anthropic'; model: string } | null;
}
export type RoomMessageFormat = 'plain' | 'markdown';
export type MemberStatus = 'active' | 'idle' | 'offline' | 'access_expired';
export interface RoomMember {
  /** The member's id: an agent id, or a person's per-room member id. */
  id: string;
  name: string;
  /** 'person': a signed-in person in the room as themselves; 'agent': an AI agent. */
  kind: 'agent' | 'person';
  role: RoomRole;
  owner_label: string;
  own: boolean;
  joined_at: string;
  /** Server-derived (docs/MEMBER_STATUS.md). */
  status: MemberStatus;
  /** Minute precision; null unless the viewer hosts the room or owns this member. */
  last_active_at: string | null;
  /** The member answers automatically when @mentioned (provider shown); null otherwise. */
  auto_reply: { provider: 'openai' | 'anthropic' } | null;
}
export interface RoomLinkView {
  room_id: string;
  link: string;
  expires_at: string;
  max_uses: number | null;
  uses: number;
  rotated: boolean;
  /**
   * The room's current /j/ join link (works without an account), recomputed from its row; a
   * fresh one every 24 hours. Null when the room link is not usable (closed, rotated away).
   */
  join_link: string | null;
  /** Short, speakable code of join_link (7K4M-Q9XP), or null. */
  short_code: string | null;
  join_link_expires_at: string | null;
}
