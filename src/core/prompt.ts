import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { stripPrefix } from './tools.js';
import { unpackToolUseId } from '../types/session-ref.js';
import { asBlocks, type AnthropicMessage, type ContentBlock } from '../types/wire.js';

/** Content block kinds the harness can carry on a user message. */
const PASSTHROUGH = new Set(['text', 'image', 'document']);

export interface PendingResults {
  sessionId: string;
  blocks: ContentBlock[];
}

/**
 * Tool results in the trailing user turn, if this continues a deferred turn.
 *
 * All must name the same session; a mix means the caller rewrote history in a
 * way no resume can honour, so the caller falls back to a cold start.
 */
export function readPendingResults(messages: AnthropicMessage[]): PendingResults | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;

  const results = asBlocks(last.content).filter((b) => b.type === 'tool_result');
  if (results.length === 0) return null;

  const blocks: ContentBlock[] = [];
  let sessionId: string | null = null;

  for (const r of results) {
    const unpacked = typeof r.tool_use_id === 'string' ? unpackToolUseId(r.tool_use_id) : null;
    if (!unpacked) return null;
    if (sessionId === null) sessionId = unpacked.sessionId;
    else if (sessionId !== unpacked.sessionId) return null;
    blocks.push({ ...r, tool_use_id: unpacked.toolUseId });
  }

  return sessionId ? { sessionId, blocks } : null;
}

/**
 * Render turns as recounted context.
 *
 * The harness accepts user messages but not assistant ones, so history cannot be
 * replayed as real turns. Only reached on a cold start — the first request, or a
 * continuation whose session we no longer hold.
 */
export function renderHistory(messages: AnthropicMessage[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    for (const b of asBlocks(m.content)) {
      if (b.type === 'text' && b.text) {
        lines.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${b.text}`);
      } else if (b.type === 'tool_use') {
        lines.push(`Assistant called ${stripPrefix(b.name ?? '')}(${JSON.stringify(b.input ?? {})})`);
      } else if (b.type === 'tool_result') {
        const body = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        lines.push(`Tool returned: ${body}`);
      } else if (b.type === 'image' || b.type === 'document') {
        lines.push(`[${b.type} attached]`);
      }
    }
  }
  return lines.join('\n');
}

const userMessage = (content: ContentBlock[], sessionId: string): SDKUserMessage =>
  ({
    type: 'user',
    parent_tool_use_id: null,
    session_id: sessionId,
    message: { role: 'user', content: content as never },
  }) as SDKUserMessage;

/**
 * Continuations replay tool results into the resumed session. Cold starts send
 * the final user turn as real content blocks so images and documents survive.
 */
export function buildPrompt(
  messages: AnthropicMessage[],
  pending: PendingResults | null,
): string | AsyncIterable<SDKUserMessage> {
  if (pending) {
    const { blocks, sessionId } = pending;
    return (async function* () {
      yield userMessage(blocks, sessionId);
    })();
  }

  const last = messages[messages.length - 1];
  const prior = messages.slice(0, -1);
  const tail = last && last.role === 'user' ? asBlocks(last.content) : [];
  const rich = tail.filter((b) => PASSTHROUGH.has(b.type));
  const context = prior.length > 0 ? renderHistory(prior) : '';

  if (rich.every((b) => b.type === 'text')) {
    const text = rich.map((b) => b.text ?? '').join('\n');
    return (context ? `${context}\n\nUser: ${text}` : text) || renderHistory(messages);
  }

  const blocks: ContentBlock[] = [];
  if (context) blocks.push({ type: 'text', text: context });
  blocks.push(...rich);

  return (async function* () {
    yield userMessage(blocks, '');
  })();
}
