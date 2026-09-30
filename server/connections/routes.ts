import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import type { Connections } from './service.js';

export interface ConnectionRouteDependencies {
  connections: Connections;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
}

/**
 * Owner console REST for cross-owner connections (docs/AI_WORKSPACES.md):
 * the same operations as the MCP tools city_create_invite, city_request_connection,
 * city_list_connection_requests, city_decide_connection and city_revoke_connection, under
 * /api/v2/connections with a console session. The owner acts with full authority.
 */
export function registerConnectionRoutes(
  app: FastifyInstance,
  d: ConnectionRouteDependencies,
): void {
  const principal = (operator: Operator) => ({ operatorId: operator.id, actor: 'the owner' });
  const idParams = z.object({ id: z.string().uuid() }).strict();
  const base = '/api/v2/connections';

  app.get(`${base}/requests`, async (request) => {
    const operator = await d.owner(request);
    const query = z
      .object({
        direction: z.enum(['incoming', 'outgoing']).optional(),
        status: z.string().max(16).optional(),
        before: z.string().max(80).optional(),
        limit: z
          .string()
          .regex(/^\d{1,3}$/)
          .transform(Number)
          .optional(),
      })
      .strict()
      .parse(request.query);
    return d.connections.list(principal(operator), query);
  });
  app.post(`${base}/requests`, async (request, reply) => {
    const operator = await d.owner(request);
    return reply.code(201).send(await d.connections.request(principal(operator), request.body));
  });
  app.post(`${base}/requests/:id/decide`, async (request) => {
    const operator = await d.owner(request);
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        decision: z.enum(['approve', 'deny']),
        deny_all_pending_from_owner: z.boolean().optional(),
      })
      .strict()
      .parse(request.body);
    return d.connections.decide(principal(operator), { request_id: id, ...body });
  });
  app.post(`${base}/requests/:id/revoke`, async (request) => {
    const operator = await d.owner(request);
    const { id } = idParams.parse(request.params);
    z.object({}).strict().parse(request.body);
    return d.connections.revoke(principal(operator), { connection_id: id });
  });
  app.get(`${base}/invites`, async (request) => {
    const operator = await d.owner(request);
    return d.connections.listInvites(principal(operator), {});
  });
  app.post(`${base}/invites`, async (request, reply) => {
    const operator = await d.owner(request);
    return reply
      .code(201)
      .send(await d.connections.createInvite(principal(operator), request.body));
  });
  app.delete(`${base}/invites/:id`, async (request) => {
    const operator = await d.owner(request);
    const { id } = idParams.parse(request.params);
    return d.connections.revokeInvite(principal(operator), { invite_id: id });
  });
  app.post(`${base}/agents/:id/requests`, async (request) => {
    const operator = await d.owner(request);
    const { id } = idParams.parse(request.params);
    const { requests_enabled } = z
      .object({ requests_enabled: z.boolean() })
      .strict()
      .parse(request.body);
    return d.connections.setRequests(principal(operator), { agent_id: id, requests_enabled });
  });
}
