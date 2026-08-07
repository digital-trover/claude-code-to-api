/**
 * The Messages API is stateless but the harness is not, and the protocol has
 * nowhere to carry a session id. `tool_use.id` is the one field a client must
 * echo back verbatim, so the session rides inside it.
 */
const SEP = '~';

export const packToolUseId = (toolUseId: string, sessionId: string): string =>
  `${toolUseId}${SEP}${sessionId}`;

export function unpackToolUseId(
  packed: string,
): { toolUseId: string; sessionId: string } | null {
  const i = packed.lastIndexOf(SEP);
  if (i <= 0 || i === packed.length - 1) return null;
  return { toolUseId: packed.slice(0, i), sessionId: packed.slice(i + 1) };
}
