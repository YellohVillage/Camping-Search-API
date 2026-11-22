/** Codes d'erreur du §11. */
export type ErrorCode =
  | 'MISSING_PARAMETER'
  | 'INVALID_DATES'
  | 'INVALID_PEOPLE_COUNT'
  | 'INVALID_ACCOMMODATION_TYPE'
  | 'INVALID_MAX_RESULTS'
  | 'INVALID_FILTER_FORMAT'
  | 'UNKNOWN_FILTER'
  | 'TOO_MANY_FILTERS'
  | 'INVALID_KEYWORDS'
  | 'INVALID_CAMPING_IDS'
  | 'NO_RESULT'
  | 'MISSING_API_KEY'
  | 'INVALID_API_KEY'
  | 'MISSING_TOKEN'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const badRequest = (code: ErrorCode, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);

export const unauthorized = (code: ErrorCode, message: string) =>
  new ApiError(
    401,
    code,
    message,
    undefined,
    code === 'INVALID_TOKEN' || code === 'TOKEN_EXPIRED' || code === 'MISSING_TOKEN'
      ? { 'WWW-Authenticate': 'Bearer error="invalid_token"' }
      : {},
  );

export function errorBody(err: ApiError, requestId: string) {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      request_id: requestId,
    },
  };
}
