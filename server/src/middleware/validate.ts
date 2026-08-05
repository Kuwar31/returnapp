import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { ZodSchema } from "zod";
import { badRequest } from "../lib/errors.js";

type Source = "body" | "query" | "params";

/**
 * Parses the given request part with a Zod schema and replaces it with the
 * parsed result, so handlers get typed, coerced, stripped input.
 */
export const validate =
  (schema: ZodSchema, source: Source = "body"): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
      }));
      return next(badRequest("The submitted data is invalid.", details));
    }
    // req.query and req.params have read-only getters in Express 5; assigning
    // via defineProperty keeps this working on both 4 and 5.
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
    });
    next();
  };
