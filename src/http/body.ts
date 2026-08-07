import type { IncomingMessage } from 'node:http';
import { ApiError, badRequest } from './errors.js';

const DEFAULT_LIMIT = 32 * 1024 * 1024;

export async function readJson(
  req: IncomingMessage,
  limitBytes = DEFAULT_LIMIT,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new ApiError(413, 'request_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (err) {
    throw badRequest(`malformed JSON body: ${(err as Error).message}`);
  }
}
