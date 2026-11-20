/** Small HTTP helpers shared by every route file. */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, ZodTypeAny, z } from "zod";
import { HttpError, badRequest } from "./lib/errors.js";
import { log } from "./lib/logger.js";

/** Wrap an async handler so a rejected promise reaches the error middleware. */
export const h = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

/** Parse and validate input; a failure is a 400 that names the offending fields. */
export function parse<S extends ZodTypeAny>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  throw badRequest("Some fields are missing or invalid.", {
    fields: r.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
  });
}

export const uuid = z.string().uuid();

export function errorMiddleware(err: any, req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details || {}) } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: "invalid_request", message: "Some fields are missing or invalid." } });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "invalid_json", message: "The request body is not valid JSON." } });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "too_large", message: "The request body is too large." } });
  }
  // Invalid uuid / malformed value reaching PostgreSQL: the caller sent a bad id.
  if (err?.code === "22P02") {
    return res.status(400).json({ error: { code: "invalid_request", message: "Invalid identifier." } });
  }
  log.error({ err, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side. Please try again." } });
}

/** Page parameters with safe bounds. */
export function paging(query: any, maxLimit = 100): { limit: number; offset: number } {
  const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(String(query?.limit ?? "25"), 10) || 25));
  const offset = Math.max(0, Number.parseInt(String(query?.offset ?? "0"), 10) || 0);
  return { limit, offset };
}
