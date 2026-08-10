import { query } from '@anthropic-ai/claude-agent-sdk';
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
import type { ContentBlock, RunRequest, StopReason, Usage } from '../types/wire.js';

export interface TurnResult {
  content: ContentBlock[];
  stop_reason: StopReason;
  model: string;
  usage: Usage;
  /** Signed, credential-bound reference the caller sends back to continue. */
  sessionRef: string;
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
          if (isUnreplayable(block.type)) continue;
          // Harness tool calls already ran; surfacing them would ask the caller
          // to execute them again.
          if (!isPendingForCaller(block)) continue;
          collected.push(block);
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

  const sessionRef = signSession(sessionId, ctx.credential?.token);

  return {
    content: collected.map((b) => (b.type === 'tool_use' ? exposeToolUse(b, sessionRef) : b)),
    stop_reason: stopReasonFor(deferred, truncated),
    model,
    usage: totals.usage,
    sessionRef,
    costUsd: totals.costUsd,
  };
}
