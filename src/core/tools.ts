/**
 * Caller-declared tools, registered with Claude Code but executed by the caller.
 *
 * A PreToolUse hook returning `defer` ends the turn with
 * `terminal_reason: 'tool_deferred'` instead of running the tool, which is what
 * lets this service behave like `/v1/messages` where the caller owns the loop.
 */
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type {
  McpSdkServerConfigWithInstance,
  Options,
  SdkMcpToolDefinition,
} from '@anthropic-ai/claude-agent-sdk';
import { z, type ZodRawShape, type ZodType } from 'zod';
import type { AnthropicToolDef, JsonSchema } from '../types/wire.js';

export const BRIDGE = 'bridge';
const PREFIX = `mcp__${BRIDGE}__`;

export const stripPrefix = (name: string): string =>
  name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;

export const addPrefix = (name: string): string => PREFIX + name;

/** True for tools the caller declared, as opposed to the harness's own. */
export const isBridgeTool = (name: string): boolean => name.startsWith(PREFIX);

const describe = (node: ZodType, description?: string): ZodType =>
  description ? node.describe(description) : node;

const union = (nodes: ZodType[]): ZodType =>
  nodes.length === 1 ? nodes[0]! : z.union(nodes as unknown as [ZodType, ZodType, ...ZodType[]]);

/**
 * JSON Schema -> Zod, covering the subset the Messages API supports.
 *
 * Unrecognised schemas degrade to `unknown` rather than throwing: the schema is
 * advisory here, since the caller executes the tool and validates its own input.
 */
function toZod(schema: JsonSchema | undefined): ZodType {
  if (!schema || typeof schema !== 'object') return z.unknown();

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return describe(union(schema.enum.map((v) => z.literal(v as never))), schema.description);
  }
  if (schema.const !== undefined) {
    return describe(z.literal(schema.const as never), schema.description);
  }

  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    return describe(union(variants.map(toZod)), schema.description);
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = types.includes('null');

  let node: ZodType;
  switch (types.find((t) => t && t !== 'null')) {
    case 'string':
      node = z.string();
      break;
    case 'number':
      node = z.number();
      break;
    case 'integer':
      node = z.number().int();
      break;
    case 'boolean':
      node = z.boolean();
      break;
    case 'array':
      node = z.array(toZod(schema.items));
      break;
    case 'object':
      node = z.object(shapeOf(schema));
      break;
    default:
      node = z.unknown();
  }

  return describe(nullable ? node.nullable() : node, schema.description);
}

function shapeOf(schema: JsonSchema | undefined): ZodRawShape {
  const required = new Set(schema?.required ?? []);
  const shape: Record<string, ZodType> = {};

  for (const [key, sub] of Object.entries(schema?.properties ?? {})) {
    const node = toZod(sub);
    shape[key] = required.has(key) ? node : node.optional();
  }
  return shape as ZodRawShape;
}

/**
 * Register the caller's tools as an in-process MCP server.
 *
 * `alwaysLoad` matters: without it the model reaches for ToolSearch first and
 * the hook defers the search instead of the real call. The handlers are
 * unreachable by design, so reaching one means the hook did not fire.
 */
export function buildBridge(tools: AnthropicToolDef[]): McpSdkServerConfigWithInstance {
  const defs: SdkMcpToolDefinition<ZodRawShape>[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    inputSchema: shapeOf(t.input_schema),
    _meta: { 'anthropic/alwaysLoad': true },
    handler: async () => ({
      content: [{ type: 'text' as const, text: 'ERROR: tool was not deferred to the host' }],
      isError: true,
    }),
  }));

  return createSdkMcpServer({ name: BRIDGE, version: '1.0.0', alwaysLoad: true, tools: defs });
}

/** Hands bridge tool calls back to the caller. Scoped so built-ins are unaffected. */
export const deferHook: NonNullable<Options['hooks']> = {
  PreToolUse: [
    {
      matcher: `${PREFIX}.*`,
      hooks: [
        async () => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'defer' as const,
            permissionDecisionReason: 'host executes caller-declared tools',
          },
        }),
      ],
    },
  ],
};
