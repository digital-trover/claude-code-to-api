/**
 * Shared turn plumbing: block translation, stop reasons, and the timeout that
 * headless does not provide for itself.
 */
import { packToolUseId } from '../types/session-ref.js';
import { stripPrefix } from './tools.js';
import type { ContentBlock, StopReason } from '../types/wire.js';

/** Signatures are bound to the harness session, so a caller cannot replay these. */
export const isUnreplayable = (type: string): boolean =>
  type === 'thinking' || type === 'redacted_thinking';

/** Strip the MCP prefix and pack the session id so the next request can resume. */
export const exposeToolUse = (block: ContentBlock, sessionId: string): ContentBlock => ({
  ...block,
  name: stripPrefix(block.name ?? ''),
  id: packToolUseId(String(block.id ?? ''), sessionId),
});

export const stopReasonFor = (deferred: boolean, truncated: boolean): StopReason =>
  deferred ? 'tool_use' : truncated ? 'max_tokens' : 'end_turn';

export interface Deadline {
  controller: AbortController;
  clear: () => void;
}

/**
 * Turn timeout, also tripped by the caller disconnecting.
 *
 * Headless provides no timeout of its own, and a client that hangs up would
 * otherwise leave the harness running and billing for output nobody receives.
 */
export function startDeadline(ms: number, external?: AbortSignal): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const onExternalAbort = () => controller.abort();

  if (external?.aborted) controller.abort();
  else external?.addEventListener('abort', onExternalAbort, { once: true });

  return {
    controller,
    clear: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onExternalAbort);
    },
  };
}
