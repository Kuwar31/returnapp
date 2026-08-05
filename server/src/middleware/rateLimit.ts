import type { Request, RequestHandler } from "express";
import { AppError } from "../lib/errors.js";

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * In-memory fixed-window limiter. Enough for a single-process dev/staging
 * setup; swap the store for Redis before running more than one instance.
 */
export const rateLimit = ({
  windowMs,
  max,
  keyFn = (req: Request) => req.ip ?? "unknown",
}: {
  windowMs: number;
  max: number;
  keyFn?: (req: Request) => string;
}): RequestHandler => {
  const buckets = new Map<string, Bucket>();

  // Drop expired buckets so the map doesn't grow without bound.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, windowMs).unref();
  void sweep;

  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retryAfter));
      return next(
        new AppError(
          429,
          "RATE_LIMITED",
          "Too many attempts. Please wait a moment and try again.",
        ),
      );
    }
    next();
  };
};
