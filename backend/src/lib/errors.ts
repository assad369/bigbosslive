/**
 * Every error a handler intentionally raises is an `AppError`. The central error middleware
 * maps it onto `{ error: { code, message, details } }`; anything else becomes a generic 500
 * so internals never leak to clients.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'bad_request', message, details);
export const validationError = (details: unknown) =>
  new AppError(422, 'validation_failed', 'Request validation failed', details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, code = 'conflict') => new AppError(409, code, message);
export const insufficientBalance = (currency = 'diamonds') =>
  new AppError(402, 'insufficient_balance', `Not enough ${currency}`);
export const tooManyRequests = (message = 'Too many requests') =>
  new AppError(429, 'rate_limited', message);
export const serviceUnavailable = (message: string) =>
  new AppError(503, 'service_unavailable', message);

/** MongoDB duplicate-key error (E11000). */
export function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 11000;
}
