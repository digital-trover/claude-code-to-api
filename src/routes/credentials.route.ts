import type { ServerResponse } from 'node:http';
import type { RequestContext } from '../server.js';
import { redact, verifyCredential } from '../core/credentials.js';
import { validateVerifyRequest } from '../validation/credentials.js';
import { badRequest } from '../http/errors.js';

/**
 * `POST /v1/credentials/verify` — check a token without spending any.
 *
 * Worth calling when a user first attaches an account: a bad token found here
 * is a form error, the same token found on first real use is a support ticket.
 */
export async function verify(ctx: RequestContext, res: ServerResponse): Promise<void> {
  const { token } = validateVerifyRequest(ctx.body);
  const result = await verifyCredential(token);

  ctx.log.info(`credential check ${redact(token)} -> ${result.valid ? 'valid' : 'invalid'}`);
  ctx.sendJson(res, result.valid ? 200 : 400, result);
}

/**
 * `POST /v1/credentials/status` — re-check the credential this request carries.
 *
 * Separate from `verify` so a scheduled health check can reuse the same header
 * it would use for real traffic, rather than moving the secret into a body.
 * Always answers 200: the credential's health is the payload, not the outcome
 * of the call, so a monitor can distinguish "token is dead" from "the check
 * itself failed".
 */
export async function status(ctx: RequestContext, res: ServerResponse): Promise<void> {
  if (!ctx.credential) {
    throw badRequest('x-claude-token: required to report credential status');
  }

  const result = await verifyCredential(ctx.credential.token);
  ctx.log.info(`credential status ${redact(ctx.credential.token)} -> ${result.status}`);
  ctx.sendJson(res, 200, result);
}
