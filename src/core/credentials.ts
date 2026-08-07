/**
 * Upstream Claude credentials.
 *
 * Header-only by design: the caller sends their own token per request and the
 * container stores none at rest, so a compromised instance costs no accounts.
 */
import { badRequest } from '../http/errors.js';

export type CredentialKind = 'oauth' | 'api-key';

export interface Credential {
  kind: CredentialKind;
  token: string;
}

const OAUTH_PREFIX = 'sk-ant-oat';
const TOKEN_PATTERN = /^sk-ant-[A-Za-z0-9_-]{10,}$/;

export const kindOf = (token: string): CredentialKind =>
  token.startsWith(OAUTH_PREFIX) ? 'oauth' : 'api-key';

/** Enough to correlate a token across logs, never enough to use it. */
export const redact = (token: string): string =>
  token.length <= 12 ? '***' : `${token.slice(0, 10)}…${token.slice(-4)}`;

/** Returns null when the header is absent; callers decide whether that is allowed. */
export function resolveCredential(headerToken: string | undefined): Credential | null {
  if (!headerToken) return null;

  const token = headerToken.trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw badRequest('x-claude-token: expected a Claude credential (sk-ant-…)');
  }
  return { kind: kindOf(token), token };
}

/**
 * Environment for the harness subprocess.
 *
 * Two things have to be true for a caller's token to actually be the one used.
 *
 * Every credential variable is written, blanking the ones that do not apply —
 * `ANTHROPIC_API_KEY` silently outranks `CLAUDE_CODE_OAUTH_TOKEN`, so a stray
 * key would route the run to the wrong account with no error.
 *
 * And `CLAUDE_CONFIG_DIR` is pointed at a service-owned directory holding no
 * stored login. Without that, the CLI treats an invalid OAuth token as absent
 * and falls back to whatever account is logged in on the host — so a caller
 * sending a junk token would silently run on someone else's account. With it,
 * the same token fails loudly with `401 OAuth access token is invalid`.
 */
export function childEnv(
  credential: Credential | null,
  sessionDir: string,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> | undefined {
  // Ambient mode deliberately inherits the host's config dir; that is where the
  // developer's own login lives, and using it is the entire point.
  if (!credential) return undefined;

  return {
    ...base,
    CLAUDE_CODE_OAUTH_TOKEN: credential.kind === 'oauth' ? credential.token : '',
    ANTHROPIC_API_KEY: credential.kind === 'api-key' ? credential.token : '',
    ANTHROPIC_AUTH_TOKEN: '',
    CLAUDE_CONFIG_DIR: sessionDir,
  };
}

/**
 * `invalid` covers expired, revoked and malformed alike — the upstream returns
 * the same 401 for all three, so claiming to tell them apart would be a guess.
 * What matters operationally is captured by `reauth_required`.
 */
export type CredentialStatus = 'valid' | 'invalid' | 'rate_limited' | 'unreachable';

export interface VerifyResult {
  valid: boolean;
  status: CredentialStatus;
  kind: CredentialKind;
  /** The user must supply a new token; retrying this one will not help. */
  reauth_required: boolean;
  reason?: string;
  checked_at: string;
}

/** Authenticates against `GET /v1/models`, which spends nothing. */
export async function verifyCredential(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const kind = kindOf(token);
  const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };

  if (kind === 'oauth') {
    // OAuth tokens are bearers and need the beta header; sent as x-api-key they 401.
    headers.authorization = `Bearer ${token}`;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
  } else {
    headers['x-api-key'] = token;
  }

  const checked_at = new Date().toISOString();

  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=1', {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      return { valid: true, status: 'valid', kind, reauth_required: false, checked_at };
    }

    const body = await res.text().catch(() => '');
    let reason = `upstream returned ${res.status}`;
    try {
      const parsed = JSON.parse(body) as { error?: { message?: string } };
      if (parsed.error?.message) reason = parsed.error.message;
    } catch {
      /* non-JSON body; the status is the signal */
    }

    // 429 and 5xx say nothing about the credential, so they must not be
    // reported as a reason to re-authenticate.
    const status: CredentialStatus =
      res.status === 401 || res.status === 403
        ? 'invalid'
        : res.status === 429
          ? 'rate_limited'
          : res.status >= 500
            ? 'unreachable'
            : 'invalid';

    return { valid: false, status, kind, reauth_required: status === 'invalid', reason, checked_at };
  } catch (err) {
    return {
      valid: false,
      status: 'unreachable',
      kind,
      reauth_required: false,
      reason: `could not reach api.anthropic.com: ${(err as Error).message}`,
      checked_at,
    };
  }
}
