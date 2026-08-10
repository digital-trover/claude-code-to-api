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
  const { options, prompt, seedSession } = prepareTurn(req, ctx, true);
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
export async function* streamRun(req: RunRequest, ctx: TurnContext): AsyncGenerator<SDKMessage> {
  const { options, prompt } = prepareTurn(req, ctx, false);
  const { controller, clear } = startDeadline(ctx.cfg.turnTimeoutMs, ctx.signal);
  try {
    for await (const msg of query({
      prompt,
      options: { ...options, abortController: controller },
    })) {
      yield msg;
    }
  } finally {
    clear();
  }
}
