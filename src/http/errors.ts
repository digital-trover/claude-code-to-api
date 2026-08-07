export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
    /** Seconds to wait, surfaced as Retry-After. */
    readonly retryAfterSeconds?: number,
    /**
     * The caller's Claude credential is dead. Distinguishes "get a new token"
     * from "retry later", which a bare 401 does not.
     */
    readonly reauthRequired?: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (message: string): ApiError =>
  new ApiError(400, 'invalid_request_error', message);

export const unauthorized = (message: string): ApiError =>
  new ApiError(401, 'authentication_error', message);

/** The upstream rejected the caller's Claude credential; a new one is needed. */
export const reauthRequired = (message: string): ApiError =>
  new ApiError(401, 'authentication_error', message, undefined, true);

export const notFound = (message: string): ApiError =>
  new ApiError(404, 'not_found_error', message);

export const notImplemented = (message: string): ApiError =>
  new ApiError(501, 'not_implemented_error', message);

/**
 * Map a thrown value onto Anthropic's error envelope.
 *
 * The harness reports upstream trouble as prose rather than a status code, so
 * rate limiting and overload are matched on message. Anything unrecognised
 * stays a 500 rather than being optimistically labelled retryable.
 */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof SyntaxError) return badRequest(`malformed JSON body: ${err.message}`);

  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.startsWith('cwd:')) return badRequest(message);
  if (lower.includes('abort')) {
    return new ApiError(504, 'timeout_error', 'turn exceeded the configured timeout');
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    return new ApiError(429, 'rate_limit_error', message);
  }
  if (lower.includes('overloaded') || lower.includes('529')) {
    return new ApiError(529, 'overloaded_error', message);
  }
  // The harness reports a dead credential as prose, e.g.
  //   "Failed to authenticate. API Error: 401 OAuth access token is invalid."
  // Expired, revoked and malformed all arrive identically, so they are reported
  // as one condition: this token will not work again.
  if (
    lower.includes('401') ||
    lower.includes('failed to authenticate') ||
    (lower.includes('invalid') && (lower.includes('token') || lower.includes('api key')))
  ) {
    return reauthRequired(message);
  }
  if (lower.includes('authentication') || lower.includes('credential')) {
    return unauthorized(message);
  }
  return new ApiError(500, 'api_error', message);
}
