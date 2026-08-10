import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../server.js';
import { runTurn } from '../core/run-turn.js';
import { streamRun } from '../core/stream-turn.js';
import type { TurnContext } from '../core/context.js';
import { relaySse } from './relay.js';
import { validateRunRequest } from '../validation/messages.js';

/** `POST /v1/runs` — agent mode; the harness keeps its own tools. */
export async function createRun(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const body = validateRunRequest(ctx.body);
  const turnCtx: TurnContext = {
    mode: 'run',
    cfg: ctx.cfg,
    workspace: ctx.workspace,
    credential: ctx.credential,
    sessionRef: ctx.sessionRef,
  };

  if (body.stream) {
    // Agent traces are for humans and dashboards, so harness messages are
    // relayed as-is rather than squeezed into the Messages event vocabulary.
    return relaySse(
      res,
      (async function* () {
        for await (const msg of streamRun(body, turnCtx)) yield { event: msg.type, data: msg };
      })(),
    );
  }

  const turn = await runTurn(body, turnCtx);
  ctx.sendJson(res, 200, {
    session_id: turn.sessionRef,
    model: turn.model,
    result: turn.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join(''),
    content: turn.content,
    stop_reason: turn.stop_reason,
    usage: turn.usage,
    cost_usd: turn.costUsd,
  });
}
