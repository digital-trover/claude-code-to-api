import { query } from '@anthropic-ai/claude-agent-sdk';
import type { TurnContext } from './context.js';
import { prepareTurn } from './options.js';
import { exposeToolUse, isUnreplayable, startDeadline, stopReasonFor } from './turn.js';
import { UsageAccumulator } from './usage.js';
import type { ContentBlock, RunRequest, StopReason, Usage } from '../types/wire.js';

export interface TurnResult {
  content: ContentBlock[];
  stop_reason: StopReason;
  model: string;
  usage: Usage;
  sessionId: string;
  /** Harness estimate, not a billing statement. */
  costUsd: number;
}

/** Run one turn to completion. */
export async function runTurn(req: RunRequest, ctx: TurnContext): Promise<TurnResult> {
  const { options, prompt, seedSession } = prepareTurn(req, ctx, false);
  const { controller, clear } = startDeadline(ctx.cfg.turnTimeoutMs, ctx.signal);

  const collected: ContentBlock[] = [];
  const totals = new UsageAccumulator();
  let sessionId = seedSession;
  let model = options.model ?? ctx.cfg.defaultModel;
  let deferred = false;
  let truncated = false;

  try {
    for await (const msg of query({
      prompt,
      options: { ...options, abortController: controller },
    })) {
      if ('session_id' in msg && msg.session_id) sessionId = msg.session_id;

      if (msg.type === 'assistant') {
        model = msg.message.model ?? model;
        if (msg.message.stop_reason === 'max_tokens') truncated = true;
        for (const block of msg.message.content as unknown as ContentBlock[]) {
          if (!isUnreplayable(block.type)) collected.push(block);
        }
      }

      if (msg.type === 'result') {
        deferred ||= msg.terminal_reason === 'tool_deferred';
        totals.absorb(msg);
      }
    }
  } finally {
    clear();
  }

  return {
    content: collected.map((b) => (b.type === 'tool_use' ? exposeToolUse(b, sessionId) : b)),
    stop_reason: stopReasonFor(deferred, truncated),
    model,
    usage: totals.usage,
    sessionId,
    costUsd: totals.costUsd,
  };
}
