import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from './context.js';
import { prepareTurn } from './options.js';
import {
  exposeToolUse,
  isPendingForCaller,
  isUnreplayable,
  startDeadline,
  stopReasonFor,
} from './turn.js';
import { signSession } from '../types/session-ref.js';
import { UsageAccumulator } from './usage.js';
import { emptyUsage, type ContentBlock, type RunRequest, type Usage } from '../types/wire.js';

export interface SseEvent {
  event: string;
  data: unknown;
}

const messageStart = (id: string, model: string, usage: Partial<Usage> = {}): SseEvent => ({
  event: 'message_start',
  data: {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...emptyUsage(), ...usage },
    },
  },
});

/**
 * Stream one turn as Anthropic SSE events.
 *
 * The harness emits raw `BetaRawMessageStreamEvent`s, so this is mostly a relay
 * with three corrections: thinking blocks are dropped and survivors renumbered
 * to stay gapless; tool_use blocks are rewritten as they open; and the upstream
 * message_delta/message_stop are suppressed, because the real stop reason is
 * only known once the `result` message reports `tool_deferred`.
 */
export async function* streamTurn(
  req: RunRequest,
  ctx: TurnContext,
  id: string,
): AsyncGenerator<SseEvent> {
  const { options, prompt, seedSession } = await prepareTurn(req, ctx, true);
  const { controller, clear } = startDeadline(ctx.cfg.turnTimeoutMs, ctx.signal);

  const totals = new UsageAccumulator();
  let sessionId = seedSession;
  let model = options.model ?? ctx.cfg.defaultModel;
  let deferred = false;
  let truncated = false;
  let started = false;
  let nextIndex = 0;

  /** Upstream block index -> ours. Absent means the block was dropped. */
  const indexMap = new Map<number, number>();
  const open = new Set<number>();

  try {
    for await (const msg of query({
      prompt,
      options: { ...options, abortController: controller },
    })) {
      if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;

      if (msg.type === 'result') {
        deferred ||= msg.terminal_reason === 'tool_deferred';
        totals.absorb(msg);
        continue;
      }
      if (msg.type === 'assistant' && msg.message.stop_reason === 'max_tokens') truncated = true;
      if (msg.type !== 'stream_event') continue;

      const event = msg.event as { type: string; [k: string]: unknown };

      if (event.type === 'message_start') {
        // A turn can span several upstream messages; the caller sees one start.
        if (started) continue;
        started = true;
        const upstream = (event.message ?? {}) as { model?: string; usage?: Partial<Usage> };
        model = upstream.model ?? model;
        yield messageStart(id, model, upstream.usage);
        continue;
      }

      if (event.type === 'content_block_start') {
        const upstreamIndex = event.index as number;
        const raw = event.content_block as ContentBlock;
        if (isUnreplayable(raw.type) || !isPendingForCaller(raw)) continue;

        const index = nextIndex++;
        indexMap.set(upstreamIndex, index);
        open.add(upstreamIndex);

        yield {
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index,
            content_block:
              raw.type === 'tool_use'
                ? exposeToolUse(raw, signSession(sessionId, ctx.credential?.token))
                : raw,
          },
        };
        continue;
      }

      if (event.type === 'content_block_delta') {
        const index = indexMap.get(event.index as number);
        if (index === undefined) continue;
        yield {
          event: 'content_block_delta',
          data: { type: 'content_block_delta', index, delta: event.delta },
        };
        continue;
      }

      if (event.type === 'content_block_stop') {
        const upstreamIndex = event.index as number;
        const index = indexMap.get(upstreamIndex);
        if (index === undefined) continue;
        open.delete(upstreamIndex);
        yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } };
      }
    }
  } finally {
    clear();
  }

  if (!started) yield messageStart(id, model);

  // An aborted turn can leave blocks open; close them so the client is not left
  // waiting on a block that never terminates.
  for (const upstreamIndex of open) {
    const index = indexMap.get(upstreamIndex);
    if (index !== undefined) {
      yield { event: 'content_block_stop', data: { type: 'content_block_stop', index } };
    }
  }

  yield {
    event: 'message_delta',
    data: {
      type: 'message_delta',
      delta: { stop_reason: stopReasonFor(deferred, truncated), stop_sequence: null },
      usage: totals.usage,
    },
  };
  yield { event: 'message_stop', data: { type: 'message_stop' } };
}

/** Raw harness events for agent-mode runs, for callers that want the trace. */
/**
 * Harness events for agent-mode runs, for callers that want the trace.
 *
 * Messages pass through largely as the harness emitted them, with one
 * correction: tool calls in assistant content are rewritten into the caller's
 * namespace, exactly as the buffered path does. Relaying them raw would hand
 * back an `mcp__bridge__`-prefixed name and an unpacked id, and a caller
 * echoing that id could not resume the session — the tool result would be
 * treated as unrelated and silently start a fresh turn instead.
 */
export async function* streamRun(req: RunRequest, ctx: TurnContext): AsyncGenerator<SDKMessage> {
  // Partial messages on: without them a caller sees nothing until a whole
  // assistant message lands, which is the difference between a reply that types
  // itself out and half a minute of silence.
  const { options, prompt, seedSession } = await prepareTurn(req, ctx, true);
  const { controller, clear } = startDeadline(ctx.cfg.turnTimeoutMs, ctx.signal);

  let sessionId = seedSession;

  try {
    for await (const msg of query({
      prompt,
      options: { ...options, abortController: controller },
    })) {
      if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;
      const sessionRef = signSession(sessionId, ctx.credential?.token);

      // Relayed messages carry the signed reference, not the harness's raw id.
      // The buffered response already returns the signed form, and a caller
      // that took the raw id from the trace would have it rejected on resume —
      // silently starting a new conversation instead of continuing this one.
      const withRef = <T extends SDKMessage>(m: T): T =>
        'session_id' in m && m.session_id ? ({ ...m, session_id: sessionRef } as T) : m;

      // `deferred_tool_use` is the same pending call surfaced on the result,
      // so it needs the same rewrite — a caller reading it instead of the
      // assistant block would otherwise get an id it cannot echo back.
      if (msg.type === 'result') {
        const deferred = (msg as { deferred_tool_use?: { id: string; name: string; input: unknown } })
          .deferred_tool_use;

        if (deferred) {
          const exposed = exposeToolUse(
            { type: 'tool_use', id: deferred.id, name: deferred.name },
            signSession(sessionId, ctx.credential?.token),
          );
          yield withRef({
            ...msg,
            deferred_tool_use: {
              id: String(exposed.id),
              name: String(exposed.name),
              input: deferred.input,
            },
          } as SDKMessage);
          continue;
        }
        yield withRef(msg);
        continue;
      }

      // Text deltas only. The other partials describe tool calls as they open,
      // carrying the bridge-prefixed name and an id that has not been packed
      // with the session yet — neither may reach the caller, and the completed
      // `assistant` message relays them properly a moment later.
      if (msg.type === 'stream_event') {
        const event = msg.event as { type?: string; delta?: { type?: string } };
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          yield withRef(msg);
        }
        continue;
      }

      if (msg.type !== 'assistant') {
        yield withRef(msg);
        continue;
      }

      const content = (msg.message.content as unknown as ContentBlock[])
        .filter((b) => !isUnreplayable(b.type) && isPendingForCaller(b))
        .map((b) => (b.type === 'tool_use' ? exposeToolUse(b, sessionRef) : b));

      yield withRef({
        ...msg,
        message: { ...msg.message, content: content as never },
      });
    }
  } finally {
    clear();
  }
}
