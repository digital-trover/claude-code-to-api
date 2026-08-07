import type { ServerResponse } from 'node:http';
import { openSse, writeSse } from '../http/respond.js';
import { toApiError } from '../http/errors.js';

export interface StreamEvent {
  event: string;
  data: unknown;
}

/** Pipe an event generator to the client as SSE. */
export async function relaySse(
  res: ServerResponse,
  events: AsyncGenerator<StreamEvent>,
): Promise<void> {
  openSse(res);
  try {
    for await (const ev of events) writeSse(res, ev.event, ev.data);
  } catch (err) {
    // Headers are already sent, so failure can only be reported in-band.
    const api = toApiError(err);
    writeSse(res, 'error', { type: 'error', error: { type: api.errorType, message: api.message } });
  } finally {
    res.end();
  }
}
