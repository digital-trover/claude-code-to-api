/**
 * Session references.
 *
 * The harness is stateful; this API is not. A reference lets a caller continue
 * a conversation without the service keeping any per-session state of its own.
 *
 * References are bound to the credential that created them. The binding key is
 * derived from the token itself, so it needs no configuration and survives a
 * restart, while a reference leaked through a log or an error message is inert
 * in anyone else's hands. Without it, a session id is a bearer token for
 * someone else's conversation on any instance serving more than one caller.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Separator inside a reference. Absent from UUIDs and from base64url. */
const SEP = '.';

/** Ambient mode has no caller credential, so all references share one key. */
const AMBIENT_KEY = 'claude-headless-api:ambient';

const keyFor = (token: string | undefined): Buffer =>
  createHash('sha256').update(token ?? AMBIENT_KEY).digest();

const tagFor = (sessionId: string, token: string | undefined): string =>
  createHmac('sha256', keyFor(token)).update(sessionId).digest('base64url').slice(0, 16);

/** Opaque, credential-bound reference to a harness session. */
export const signSession = (sessionId: string, token: string | undefined): string =>
  sessionId ? `${sessionId}${SEP}${tagFor(sessionId, token)}` : '';

/**
 * Recover the session id from a reference, or null if it does not verify —
 * forged, corrupted, or issued to a different credential. Callers must treat
 * null as "start fresh", never as "resume anyway".
 */
export function verifySession(reference: string, token: string | undefined): string | null {
  const at = reference.lastIndexOf(SEP);
  if (at <= 0 || at === reference.length - 1) return null;

  const sessionId = reference.slice(0, at);
  const presented = reference.slice(at + 1);
  const expected = tagFor(sessionId, token);

  return equalSecret(presented, expected) ? sessionId : null;
}

/**
 * Constant-time string comparison.
 *
 * Both sides are hashed first so the comparison is over fixed-length digests.
 * Comparing the raw strings would need a length check before `timingSafeEqual`,
 * and that check is itself observable — it tells an attacker when they have the
 * length right, which is the first thing worth learning.
 */
export function equalSecret(a: string, b: string): boolean {
  const key = createHash('sha256').update('compare').digest();
  return timingSafeEqual(
    createHmac('sha256', key).update(a).digest(),
    createHmac('sha256', key).update(b).digest(),
  );
}

// A continuation also has to survive the tool loop, where the only field a
// client is required to echo back verbatim is `tool_use.id`. The signed
// reference rides inside it.

const TOOL_SEP = '~';

export const packToolUseId = (toolUseId: string, sessionRef: string): string =>
  `${toolUseId}${TOOL_SEP}${sessionRef}`;

export function unpackToolUseId(
  packed: string,
): { toolUseId: string; sessionRef: string } | null {
  const at = packed.lastIndexOf(TOOL_SEP);
  if (at <= 0 || at === packed.length - 1) return null;
  return { toolUseId: packed.slice(0, at), sessionRef: packed.slice(at + 1) };
}
