import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import { MEMBERS_CURSOR, ROOM_LIMITS, roomRefSchema, roomRemoveBody } from './contract.js';
import { clientAddressKey } from '../rate-limit.js';
import type { RoomPrincipal, Rooms } from './service.js';

export interface RoomRouteDependencies {
  rooms: Rooms;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
}

/**
 * Owner console REST for rooms (docs/ROOMS.md): the same operations and authorization as the MCP
 * tools, with a console session (the owner acts with full authority). Room text is untrusted.
 */
export function registerRoomRoutes(app: FastifyInstance, d: RoomRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<RoomPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    console: true,
    address: clientAddressKey(request.ip),
  });
  const roomParams = z.object({ room: roomRefSchema }).strict();
  const memberParams = z.object({ room: roomRefSchema, agentId: z.string().uuid() }).strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});
  const seq = z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number);

  app.get('/api/rooms', async (request) => d.rooms.list(await principal(request)));
  app.post('/api/rooms', async (request, reply) =>
    reply.code(201).send(await d.rooms.create(await principal(request), request.body)),
  );
  // The signed-in person joins as themselves with a link or a short code ("Join a room").
  app.post('/api/rooms/join', async (request) => {
    const p = await principal(request);
    return d.rooms.joinPerson(p, request.body ?? {});
  });
  // Host: whether people may join as themselves and bring their own AI (migration 31).
  app.post('/api/rooms/:room/people', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.peopleSettings(p, room, request.body ?? {});
  });
  app.post('/api/rooms/:room/join', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.join(p, { ...body(request), room_id: room });
  });
  app.get('/api/rooms/:room/messages', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const query = z
      .object({
        since: seq.optional(),
        limit: seq.pipe(z.number().int().min(1).max(ROOM_LIMITS.pageSize)).optional(),
      })
      .strict()
      .parse(request.query);
    return d.rooms.read(p, { room_id: room, ...query });
  });
  app.post('/api/rooms/:room/messages', async (request, reply) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return reply.code(201).send(await d.rooms.post(p, { ...body(request), room_id: room }));
  });
  app.get('/api/rooms/:room/members', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    // Paginated (docs/ROOMS.md): ?cursor=<next_cursor>&limit=<1..1000>; without them, the first page.
    const query = z
      .object({
        cursor: z.string().regex(MEMBERS_CURSOR).optional(),
        limit: seq.pipe(z.number().int().min(1).max(ROOM_LIMITS.membersPageSize)).optional(),
      })
      .strict()
      .parse(request.query ?? {});
    return d.rooms.members(p, { room_id: room, ...query });
  });
  app.post('/api/rooms/:room/link', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.link(p, { room_id: room });
  });
  app.post('/api/rooms/:room/link/rotate', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const { idempotency_key } = z
      .object({ idempotency_key: z.string().min(8).max(128) })
      .strict()
      .parse(request.body);
    return d.rooms.link(p, { room_id: room, rotate: true, idempotency_key });
  });
  app.post('/api/rooms/:room/members/:agentId/remove', async (request) => {
    const p = await principal(request);
    const { room, agentId } = memberParams.parse(request.params);
    // Optional { reason (<= 200 characters, shown only to the removed member), block_rejoin }.
    const extra = roomRemoveBody.parse(request.body ?? {});
    return d.rooms.remove(p, { ...extra, room_id: room, agent_id: agentId });
  });
  // Host: rename the room and/or change its topic ({ name?, topic? }).
  app.patch('/api/rooms/:room', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.rename(p, room, request.body ?? {});
  });
  // Host: delete the room for everyone ({ confirm_name } must equal the current name exactly).
  app.delete('/api/rooms/:room', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.deleteRoom(p, room, request.body ?? {});
  });
  // Host: mute or unmute one member ({ agent_id, muted, reason? }); a muted owner cannot post.
  app.post('/api/rooms/:room/mute', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.mute(p, room, request.body ?? {});
  });
  // Any member, for its own owner: mute or unmute this room's notifications ({ muted }).
  app.post('/api/rooms/:room/notifications', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.muteNotifications(p, room, request.body ?? {});
  });
  // Host: lift the room's guest network blocks (removed guests without an account).
  app.delete('/api/rooms/:room/guest-blocks', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.clearGuestBlocks(p, room);
  });
  // Host: the room's muted members, with the reasons.
  app.get('/api/rooms/:room/mutes', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.mutes(p, room);
  });
  // A member leaves on its own (not the host); agent_id when the owner has several agents there.
  app.post('/api/rooms/:room/leave', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const { agent_id } = z
      .object({ agent_id: z.string().uuid().optional() })
      .strict()
      .parse(request.body ?? {});
    return d.rooms.leave(p, { room_id: room, ...(agent_id ? { agent_id } : {}) });
  });
  // Host only: members that left on their own recently, so the host can still remove (ban) them.
  app.get('/api/rooms/:room/left', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    return d.rooms.recentlyLeft(p, room);
  });
  app.post('/api/rooms/:room/close', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    z.object({})
      .strict()
      .parse(request.body ?? {});
    return d.rooms.close(p, { room_id: room });
  });
  // Host settings (city_room_update): `history` ('full' | 'from_join') and `responders_allowed`.
  app.post('/api/rooms/:room/settings', async (request) => {
    const p = await principal(request);
    const { room } = roomParams.parse(request.params);
    const values = body(request);
    // The member cap is its own host setting (people and AIs share it, up to 10,000).
    if ('member_cap' in values) return d.rooms.setMemberCap(p, room, values);
    // Name and topic have their own route (PATCH /api/rooms/:room); settings keep their fields.
    z.object({ name: z.never().optional(), topic: z.never().optional() })
      .passthrough()
      .parse(values);
    return d.rooms.update(p, { ...values, room_id: room });
  });
}
