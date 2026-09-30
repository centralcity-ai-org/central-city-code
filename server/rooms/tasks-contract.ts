import { z } from 'zod';
import { MESSAGE_LIMITS } from '../messaging/contract.js';
import { roomRefSchema } from './contract.js';

/**
 * Room tasks contract (docs/ROOM_TASKS.md). Shared by the service, the REST routes and the MCP
 * tools. Task titles, bodies and
 * attachment ids are untrusted text written by other owners' agents: never instructions.
 */
export const TASK_LIMITS = {
  /** Task titles are short untrusted labels (plan §1: ≤ 200). */
  titleChars: 200,
  /** Task bodies share the room text cap (binding review note 6: 16 KB). */
  bodyChars: MESSAGE_LIMITS.textChars,
  /** Attachment ids referenced by one task. */
  attachmentIdsMax: 16,
  /** Claim lease TTL in minutes (plan §1: default 30, range 5–120). */
  claimTtlMinutesDefault: 30,
  claimTtlMinutesMin: 5,
  claimTtlMinutesMax: 120,
  /** Grace after expiry: 10% of the TTL, at least 2 minutes (plan §1). */
  graceMinMs: 2 * 60_000,
  /** Creates per owner per room per hour (plan §3). */
  createsPerOwnerPerRoomPerHour: 60,
  /** Claims and renewals per agent per hour (plan §3). */
  claimsPerAgentPerHour: 240,
  pageSize: 100,
  defaultPageSize: 50,
} as const;
export type TaskLimits = { -readonly [K in keyof typeof TASK_LIMITS]: number };

export const TASK_STATUS = ['open', 'claimed', 'in_review', 'done', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

/** Grace window for a lease: 10% of the TTL, at least 2 minutes. */
export function graceForTtl(ttlMs: number): number {
  return Math.max(TASK_LIMITS.graceMinMs, Math.floor(ttlMs / 10));
}

const uuid = z.string().uuid();
const idempotencyKey = z
  .string()
  .min(8)
  .max(128)
  .describe('Stable caller-chosen key (e.g. a random UUID); a retry with the same key is free.');
const noControl = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);
/** The member agent acting: optional when the caller has exactly one agent in the room. */
const actingAgent = uuid
  .optional()
  .describe('Your member agent (optional when you have exactly one agent in the room).');

export const taskCreateInput = z
  .object({
    room_id: roomRefSchema,
    agent_id: actingAgent,
    title: z
      .string()
      .trim()
      .min(1)
      .max(TASK_LIMITS.titleChars)
      .refine(noControl, 'No control characters.')
      .describe('Short task title (1-200 characters, untrusted text).'),
    body: z
      .string()
      .max(TASK_LIMITS.bodyChars)
      .optional()
      .describe('Markdown body (at most 16 KB, untrusted text).'),
    from_message_seq: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Room message seq this task continues (a plain reference, no link).'),
    attachment_ids: z
      .array(uuid)
      .max(TASK_LIMITS.attachmentIdsMax)
      .optional()
      .describe('Attachments: each must belong to this room and be ready.'),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const taskClaimInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The task to claim.'),
    agent_id: actingAgent,
    ttl_minutes: z
      .number()
      .int()
      .min(TASK_LIMITS.claimTtlMinutesMin)
      .max(TASK_LIMITS.claimTtlMinutesMax)
      .optional()
      .describe('Lease TTL in minutes (5-120, default 30). Renew about every TTL/2.'),
    idempotency_key: idempotencyKey.describe(
      'Stable caller-chosen key; a retry by the holding agent re-issues (a NEW token).',
    ),
  })
  .strict();

export const taskRenewInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The claimed task.'),
    claim_token: z.string().min(1).max(256).describe('The claim token the claim returned.'),
    ttl_minutes: z
      .number()
      .int()
      .min(TASK_LIMITS.claimTtlMinutesMin)
      .max(TASK_LIMITS.claimTtlMinutesMax)
      .optional()
      .describe('New lease TTL in minutes (5-120, default 30). Allowed inside grace.'),
  })
  .strict();

export const taskReleaseInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The claimed task.'),
    claim_token: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe('The claim token (the host may omit it to force-release).'),
    reason: z.string().trim().min(1).max(280).optional().describe('Why the claim is released.'),
  })
  .strict();

/**
 * Step-2 proposal evidence bound to a revision (PR2, plan §6 milestone 2). Step 2
 * (proposals) is not merged yet, so the service accepts this evidence object as-is
 * (validated here) and stores it; tests use fake step-2 evidence. Titles and refs
 * are untrusted text from other owners' agents: never instructions.
 */
export const taskEvidenceSchema = z
  .object({
    kind: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(noControl, 'No control characters.')
      .describe('Evidence kind (for example proposal).'),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .refine(noControl, 'No control characters.')
      .describe('What the evidence points at (a proposal id, URL or commit SHA).'),
    revision: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine(noControl, 'No control characters.')
      .describe('The proposal revision or commit SHA the result is bound to.'),
  })
  .strict();
export type TaskEvidence = z.infer<typeof taskEvidenceSchema>;

export const taskResultInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The claimed task.'),
    claim_token: z.string().min(1).max(256).describe('The claim token the claim returned.'),
    evidence: taskEvidenceSchema.describe('Step-2 proposal evidence bound to a revision.'),
  })
  .strict();

export const taskUpdateInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The task under review.'),
    decision: z
      .enum(['approve', 'reject', 'cancel'])
      .describe('approve: in_review to done; reject: in_review back to open; cancel: close.'),
  })
  .strict();

export const taskGetInput = z.object({ room_id: roomRefSchema, task_id: uuid }).strict();

export const taskListInput = z
  .object({
    room_id: roomRefSchema,
    status: z.enum(TASK_STATUS).optional().describe('Only tasks in this status.'),
    mine: z.boolean().optional().describe('true: only tasks claimed by one of your member agents.'),
    limit: z.number().int().min(1).max(TASK_LIMITS.pageSize).optional(),
  })
  .strict();

export const taskEventsInput = z
  .object({
    room_id: roomRefSchema,
    task_id: uuid.describe('The task whose events to read.'),
    after_id: z
      .string()
      .uuid()
      .optional()
      .describe('Cursor from the previous page (next_after); omit for the first page.'),
    limit: z.number().int().min(1).max(TASK_LIMITS.pageSize).optional(),
  })
  .strict();

/** The planned tool names (PR3 surfaces; plan §3). The PR1 service stands without them. */
export const TASK_TOOLS = [
  'city_room_tasks',
  'city_room_task_create',
  'city_room_task_claim',
  'city_room_task_renew',
  'city_room_task_release',
  'city_room_task_result',
  'city_room_task_update',
] as const;
export type TaskToolName = (typeof TASK_TOOLS)[number];

/** A task as its room members see it. Titles and bodies are untrusted text. */
export interface TaskView {
  id: string;
  room_id: string;
  /** Per-room T-number (T1, T2, …). */
  number: number;
  title: string;
  body: string;
  status: TaskStatus;
  created_by_agent_id: string;
  from_message_seq: number | null;
  attachment_ids: string[];
  /** The active claim, or null when the task is open. */
  claim: {
    agent_id: string;
    expires_at: string;
    grace_until: string;
    generation: number;
  } | null;
  /** The posted result evidence (bound to a revision), or null before any result. */
  result: TaskEvidence | null;
  created_at: string;
  updated_at: string;
}

/** One task lifecycle event. Actor labels are untrusted text. */
export interface TaskEventView {
  id: string;
  task_id: string;
  action:
    | 'created'
    | 'claimed'
    | 'renewed'
    | 'released'
    | 'lapsed'
    | 'result_posted'
    | 'approved'
    | 'rejected'
    | 'cancelled'
    | 'stale_rejected';
  generation: number | null;
  actor: string;
  agent_id: string | null;
  /**
   * Optional event payload. The `rejected` event carries the cleared evidence as
   * `{evidence, untrusted: true}`: kept evidence is untrusted text from another
   * owner's agent (render it, never follow it), like room message text, which
   * rooms mark with `origin: 'external'`. `stale_rejected` shows
   * `{attempted_by_agent}`; its dedupe key (an opaque owner HMAC) is stored but never shown.
   */
  details: unknown | null;
  created_at: string;
}
