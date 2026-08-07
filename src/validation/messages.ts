import { badRequest } from '../http/errors.js';
import type { MessagesRequest, RunRequest } from '../types/wire.js';
import {
  assertNoDuplicates,
  assertNonEmptyArray,
  assertObject,
  assertOptionalBoolean,
  assertOptionalPositiveInt,
  assertOptionalString,
  assertPattern,
} from './assert.js';

/**
 * Tool names are routed as `mcp__bridge__<name>`, so they must survive that
 * concatenation without becoming ambiguous.
 */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const ROLES = new Set(['user', 'assistant']);

function validateMessages(value: unknown): void {
  const messages = assertNonEmptyArray(value, 'messages');

  messages.forEach((raw, i) => {
    const m = assertObject(raw, `messages.${i}`);
    if (typeof m.role !== 'string' || !ROLES.has(m.role)) {
      throw badRequest(`messages.${i}.role: must be "user" or "assistant"`);
    }
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) {
      throw badRequest(`messages.${i}.content: must be a string or an array of content blocks`);
    }
  });
}

function validateTools(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw badRequest('tools: must be an array');

  const names = value.map((raw, i) => {
    const tool = assertObject(raw, `tools.${i}`);
    if (typeof tool.name !== 'string' || tool.name.length === 0) {
      throw badRequest(`tools.${i}.name: required, must be a string`);
    }
    assertPattern(tool.name, TOOL_NAME, `tools.${i}.name`);
    assertOptionalString(tool.description, `tools.${i}.description`);
    return tool.name;
  });

  assertNoDuplicates(names, 'tools');
}

/** Validates and narrows a `/v1/messages` body. */
export function validateMessagesRequest(body: unknown): MessagesRequest {
  const req = assertObject(body, 'body');

  validateMessages(req.messages);
  validateTools(req.tools);
  assertOptionalString(req.model, 'model');
  assertOptionalBoolean(req.stream, 'stream');
  assertOptionalPositiveInt(req.max_tokens, 'max_tokens');

  if (req.system !== undefined && typeof req.system !== 'string' && !Array.isArray(req.system)) {
    throw badRequest('system: must be a string or an array of content blocks');
  }

  return req as unknown as MessagesRequest;
}

/** Validates a `/v1/runs` body — the messages shape plus agent-mode fields. */
export function validateRunRequest(body: unknown): RunRequest {
  const req = validateMessagesRequest(body) as RunRequest & Record<string, unknown>;

  assertOptionalString(req.cwd, 'cwd');
  assertOptionalString(req.session_id, 'session_id');
  assertOptionalPositiveInt(req.max_turns, 'max_turns');

  if (req.allowed_tools !== undefined) {
    if (!Array.isArray(req.allowed_tools) || req.allowed_tools.some((t) => typeof t !== 'string')) {
      throw badRequest('allowed_tools: must be an array of strings');
    }
  }

  return req;
}
