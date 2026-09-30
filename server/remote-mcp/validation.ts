import type {
  CallToolResult,
  McpServer,
  RegisteredTool,
  StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describeValidation } from '../validation-errors.js';

/**
 * Uniform argument errors for every remote MCP tool.
 *
 * The SDK validates `tools/call` arguments against a tool's input schema before the tool's
 * handler runs, and reports a failure as plain text ("Input validation error: Invalid arguments
 * for tool ...") without our `code` or `issues`. This module moves that step into the handler
 * path: each tool is re-registered with an advertise-only schema (its JSON Schema, and so
 * tools/list, is exactly the real schema's, but it accepts any arguments), and the real zod
 * schema runs first inside the handler. A failure becomes the same isError result as every other
 * tool error: `{error: {code: 'invalid_arguments', message, retryable: false, issues}}`, built by
 * describeValidation, which names fields and constraints and never echoes received values.
 *
 * Order is unchanged: the HTTP scope step-up (403) still runs before dispatch, argument
 * validation still runs before the tool's own handler (and so before its in-handler scope and
 * link checks), and valid arguments reach the handler parsed exactly as the SDK parsed them.
 */

/** A schema that advertises `schema`'s JSON Schema but accepts every input unchanged. */
export function advertiseOnly(schema: StandardSchemaWithJSON): StandardSchemaWithJSON {
  const standard = schema['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: standard.vendor,
      validate: (value: unknown) => ({ value }),
      jsonSchema: standard.jsonSchema,
    },
  } as StandardSchemaWithJSON;
}

/** The isError result for arguments that fail the tool's schema. */
export function invalidArgumentsResult(tool: string, error: z.ZodError): CallToolResult {
  const { message, issues } = describeValidation(error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: { code: 'invalid_arguments', message, retryable: false, issues },
        }),
      },
      // city_room_post states its outcome explicitly on every failure (see tools.ts).
      ...(tool === 'city_room_post'
        ? [{ type: 'text' as const, text: `Not posted: ${message} Nothing was added to the room.` }]
        : []),
    ],
  };
}

type Handler = (args: unknown, ctx: unknown) => CallToolResult | Promise<CallToolResult>;

/**
 * Applies the uniform validation to every tool registered on `server` (call it after the tools
 * are registered, before the server is connected). Tools without a zod input schema are left to
 * the SDK. Returns the same server.
 */
export function withUniformValidation(server: McpServer): McpServer {
  // The SDK keeps registered tools in a private map (`_registeredTools`, as of
  // @modelcontextprotocol/server 2.1.0); RegisteredTool.update is its public API. Recheck on
  // every SDK upgrade: tests/mcp-validation.test.ts fails if this stops applying.
  const tools = (server as unknown as { _registeredTools?: unknown })._registeredTools;
  if (tools === null || typeof tools !== 'object')
    throw new Error(
      'MCP SDK internals changed: _registeredTools not found; recheck server/remote-mcp/validation.ts after the SDK upgrade',
    );
  for (const [name, tool] of Object.entries(tools as Record<string, RegisteredTool>)) {
    const schema = tool.inputSchema;
    if (!(schema instanceof z.ZodType)) continue;
    const handler = tool.handler as unknown as Handler;
    const callback: Handler = async (args, ctx) => {
      // The SDK passes `arguments ?? {}` to the schema; the advertise-only schema returns it as is.
      const parsed = await schema.safeParseAsync(args ?? {});
      if (!parsed.success) return invalidArgumentsResult(name, parsed.error);
      return handler(parsed.data, ctx);
    };
    tool.update({
      paramsSchema: advertiseOnly(schema),
      callback: callback as unknown as NonNullable<
        Parameters<RegisteredTool['update']>[0]['callback']
      >,
    });
  }
  return server;
}
