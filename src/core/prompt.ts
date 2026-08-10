import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { stripPrefix } from './tools.js';
import { unpackToolUseId } from '../types/session-ref.js';
import { asBlocks, type AnthropicMessage, type ContentBlock } from '../types/wire.js';

/** Content block kinds the harness can carry on a user message. */
const PASSTHROUGH = new Set(['text', 'image', 'document']);

export interface PendingResults {
  sessionRef: string;
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
  let sessionRef: string | null = null;

  for (const r of results) {
    const unpacked = typeof r.tool_use_id === 'string' ? unpackToolUseId(r.tool_use_id) : null;
    if (!unpacked) return null;
    if (sessionRef === null) sessionRef = unpacked.sessionRef;
    else if (sessionRef !== unpacked.sessionRef) return null;
    blocks.push({ ...r, tool_use_id: unpacked.toolUseId });
  }

  return sessionRef ? { sessionRef, blocks } : null;
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
 * Build the prompt for a turn.
 *
 * Three cases, and the distinction matters:
 *
 *  - Answering deferred tool calls: replay the results into the session.
 *  - Continuing a session: send only the new user turn. The transcript is
 *    already there, so re-sending the history would show the model its own
 *    conversation twice.
 *  - Cold start: render the earlier turns as recounted context, since the
 *    harness accepts user messages but not assistant ones.
 */
export function buildPrompt(
  messages: AnthropicMessage[],
  pending: PendingResults | null,
  resuming: boolean,
): string | AsyncIterable<SDKUserMessage> {
  if (pending) {
    const { blocks } = pending;
    return (async function* () {
      yield userMessage(blocks, '');
    })();
  }

  const last = messages[messages.length - 1];
  const prior = messages.slice(0, -1);
  const tail = last && last.role === 'user' ? asBlocks(last.content) : [];
  const rich = tail.filter((b) => PASSTHROUGH.has(b.type));
  const context = resuming || prior.length === 0 ? '' : renderHistory(prior);

  if (rich.every((b) => b.type === 'text')) {
    const text = rich.map((b) => b.text ?? '').join('\n');
    const prompt = context ? `${context}\n\nUser: ${text}` : text;
    return prompt || (resuming ? '' : renderHistory(messages));
  }

  const blocks: ContentBlock[] = [];
  if (context) blocks.push({ type: 'text', text: context });
  blocks.push(...rich);

  return (async function* () {
    yield userMessage(blocks, '');
  })();
}
