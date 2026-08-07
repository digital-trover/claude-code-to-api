import type { ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { RequestContext } from '../server.js';
import { notImplemented } from '../http/errors.js';

const MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'] as const;

const specUrl = new URL('../../openapi.json', import.meta.url);

export function listModels(ctx: RequestContext, res: ServerResponse): void {
  ctx.sendJson(res, 200, {
    data: MODELS.map((id) => ({ type: 'model', id, display_name: id })),
    has_more: false,
  });
}

/**
 * Liveness. Stays 200 while draining — a failing liveness probe would have the
 * orchestrator kill the pod before in-flight turns finish.
 */
export function health(ctx: RequestContext, res: ServerResponse): void {
  ctx.sendJson(res, 200, { ok: true, model: ctx.cfg.defaultModel, draining: ctx.draining });
}

/**
 * Readiness. Fails while draining so the instance leaves the load balancer
 * before it starts refusing work.
 */
export function ready(ctx: RequestContext, res: ServerResponse): void {
  ctx.sendJson(res, ctx.draining ? 503 : 200, { ready: !ctx.draining });
}

export async function openapi(ctx: RequestContext, res: ServerResponse): Promise<void> {
  ctx.sendJson(res, 200, JSON.parse(await readFile(specUrl, 'utf8')));
}

/**
 * The harness reports usage only after a turn runs and exposes no counting
 * endpoint. An estimate here would fail later and further from the cause.
 */
export function countTokens(): never {
  throw notImplemented(
    'count_tokens is not available through the headless harness. Call ' +
      'api.anthropic.com/v1/messages/count_tokens directly, or read usage from a completed turn.',
  );
}
