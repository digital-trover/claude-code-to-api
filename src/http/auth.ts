import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** Reads the service token from either accepted header. */
export function presentedToken(req: IncomingMessage): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string') return header;

  const bearer = req.headers.authorization;
  return typeof bearer === 'string' && bearer.startsWith('Bearer ') ? bearer.slice(7) : undefined;
}

/** Compares in constant time, without letting a length mismatch short-circuit. */
export function authorized(req: IncomingMessage, expected: string): boolean {
  if (!expected) return true;

  const presented = presentedToken(req);
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
