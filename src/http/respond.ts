import type { ServerResponse } from 'node:http';
import type { ApiError } from './errors.js';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: ApiError): void {
  // `reauth_required` is additive: clients that ignore it still see a normal
  // Anthropic-shaped authentication_error.
  const error: Record<string, unknown> = { type: err.errorType, message: err.message };
  if (err.reauthRequired) error.reauth_required = true;

  sendJson(
    res,
    err.status,
    { type: 'error', error },
    err.retryAfterSeconds ? { 'retry-after': String(err.retryAfterSeconds) } : {},
  );
}

export function openSse(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Buffering proxies hold the whole turn, which makes long turns look hung.
    'x-accel-buffering': 'no',
  });
  res.flushHeaders?.();
}

export const writeSse = (res: ServerResponse, event: string, data: unknown): void => {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};
