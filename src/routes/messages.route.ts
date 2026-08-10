import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../server.js';
import { runTurn } from '../core/run-turn.js';
import { streamTurn } from '../core/stream-turn.js';
import type { TurnContext } from '../core/context.js';
import { relaySse } from './relay.js';
import { validateMessagesRequest } from '../validation/messages.js';
import { messageId } from '../types/wire.js';

/** `POST /v1/messages` — Anthropic Messages API emulation. */
export async function createMessage(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const body = validateMessagesRequest(ctx.body);
  const turnCtx: TurnContext = {
    mode: 'messages',
    cfg: ctx.cfg,
    workspace: ctx.workspace,
    credential: ctx.credential,
    sessionRef: ctx.sessionRef,
  };
  const id = messageId();

  if (body.stream) return relaySse(res, streamTurn(body, turnCtx, id));

  const turn = await runTurn(body, turnCtx);
  ctx.sendJson(res, 200, {
    id,
    type: 'message',
    role: 'assistant',
    model: turn.model,
    content: turn.content,
    stop_reason: turn.stop_reason,
    stop_sequence: null,
    usage: turn.usage,
    // Additive; clients that ignore it stay wire-compatible.
    _headless: { session_id: turn.sessionRef, cost_usd: turn.costUsd },
  });
}
