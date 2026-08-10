/**
 * Shared turn plumbing: block translation, stop reasons, and the timeout that
 * headless does not provide for itself.
 */
import { packToolUseId } from '../types/session-ref.js';
import { isBridgeTool, stripPrefix } from './tools.js';
import type { ContentBlock, StopReason } from '../types/wire.js';

/** Signatures are bound to the harness session, so a caller cannot replay these. */
export const isUnreplayable = (type: string): boolean =>
  type === 'thinking' || type === 'redacted_thinking';

/**
 * Whether a tool call is the caller's to execute.
 *
 * In agent mode the harness runs its own tools and only bridge tools are
 * deferred back. Returning an already-executed `Write` alongside a pending
 * `submit_build` would tell a protocol-following client to execute both and
 * answer with two tool_results, when only one call is actually outstanding.
 */
export const isPendingForCaller = (block: ContentBlock): boolean =>
  block.type !== 'tool_use' || isBridgeTool(block.name ?? '');

/** Strip the MCP prefix and pack the session reference so the caller can resume. */
export const exposeToolUse = (block: ContentBlock, sessionRef: string): ContentBlock => ({
  ...block,
  name: stripPrefix(block.name ?? ''),
  id: packToolUseId(String(block.id ?? ''), sessionRef),
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
