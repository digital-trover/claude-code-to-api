import type { IncomingMessage } from 'node:http';
import { equalSecret } from '../types/session-ref.js';

/** Reads the service token from either accepted header. */
export function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string') return header;

  const bearer = req.headers.authorization;
  return typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined;
}

/** Constant-time, and without a length check that would leak the token's size. */
export function authorized(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true;

  const presented = presentedToken(req);
  return presented !== undefined && equalSecret(presented, expected);
}
