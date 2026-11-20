/** An error that is safe to show to the caller. Anything else becomes a generic 500. */
export class HttpError extends Error {
  status: number;
  code: string;
  details?: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) => new HttpError(400, "invalid_request", message, details);
export const unauthorized = (message = "Sign in to continue.") => new HttpError(401, "unauthenticated", message);
export const forbidden = (message = "You do not have access to this.") => new HttpError(403, "forbidden", message);
export const notFound = (what = "Not found") => new HttpError(404, "not_found", what);
export const conflict = (message: string, details?: Record<string, unknown>) => new HttpError(409, "conflict", message, details);
export const tooMany = (message: string, retryAfterSeconds?: number) => new HttpError(429, "rate_limited", message, retryAfterSeconds ? { retryAfterSeconds } : undefined);
