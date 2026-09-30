import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Operator } from '../../shared/types.js';
import type { ResultPrincipal, Results } from './service.js';

export interface ResultRouteDependencies {
  results: Results;
  /** The workspace the console request acts in (own or co-owned AI workspace). */
  owner(request: FastifyRequest): Promise<Operator>;
  originOf(request: FastifyRequest): string;
}

/**
 * Owner console REST for published results (docs/ANSWERS.md): the same service, authorization,
 * idempotency and errors as the MCP tools, with a console session (the owner acts with full
 * authority; `X-City-Request: 1` is enforced for every POST by the root hook). The question of an
 * ask travels in the body, never in the URL.
 */
export function registerResultRoutes(app: FastifyInstance, d: ResultRouteDependencies): void {
  const principal = async (request: FastifyRequest): Promise<ResultPrincipal> => ({
    operatorId: (await d.owner(request)).id,
    actor: 'the owner',
    origin: d.originOf(request),
    address: request.ip,
  });
  const idParams = z.object({ id: z.string().uuid() }).strict();
  const askParams = z.object({ askId: z.string().uuid() }).strict();
  const body = (request: FastifyRequest) =>
    z.record(z.string(), z.unknown()).parse(request.body ?? {});

  app.get('/api/results', async (request) => {
    z.object({ mine: z.literal('1') })
      .strict()
      .parse(request.query);
    return d.results.list(await principal(request));
  });
  app.get('/api/results/:id', async (request) => {
    const p = await principal(request);
    const { id } = idParams.parse(request.params);
    return d.results.get(p, id);
  });
  app.post('/api/results', async (request, reply) =>
    reply.code(201).send(await d.results.publish(await principal(request), request.body)),
  );
  app.post('/api/results/:id/unpublish', async (request) => {
    const p = await principal(request);
    const { id } = idParams.parse(request.params);
    return d.results.unpublish(p, { ...body(request), result_id: id });
  });
  // Errors, codes and Retry-After come from the root handler (503 ask_timeout included).
  app.post('/api/ask', async (request) => d.results.ask(await principal(request), request.body));
  app.post('/api/ask/:askId/reuse', async (request) => {
    const p = await principal(request);
    const { askId } = askParams.parse(request.params);
    return d.results.report(p, { ...body(request), ask_id: askId });
  });
}
