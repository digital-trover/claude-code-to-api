import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { emptyUsage, type Usage } from '../types/wire.js';

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

/** `modelUsage` is cumulative per query() call, so totals are replaced, not summed. */
export class UsageAccumulator {
  readonly usage: Usage = emptyUsage();
  costUsd = 0;

  absorb(msg: ResultMessage): void {
    const next = emptyUsage();
    let cost = 0;

    for (const m of Object.values(msg.modelUsage ?? {})) {
      next.input_tokens += m.inputTokens ?? 0;
      next.output_tokens += m.outputTokens ?? 0;
      next.cache_creation_input_tokens += m.cacheCreationInputTokens ?? 0;
      next.cache_read_input_tokens += m.cacheReadInputTokens ?? 0;
      cost += m.costUSD ?? 0;
    }

    Object.assign(this.usage, next);
    this.costUsd = cost;
  }
}
