import type { NextFunction, Request, RequestHandler, Response } from "express";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifyAdminToken, verifyPortalToken } from "../lib/tokens.js";

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
};

/** Merchant staff routes: /api/admin/* */
export const requireAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = bearer(req) ?? req.cookies?.admin_token ?? null;
  if (!token) return next(unauthorized());

  const payload = verifyAdminToken(token);
  if (!payload) return next(unauthorized("Your session has expired."));

  req.admin = payload;
  next();
};

/** Restricts a route to certain staff roles. Use after requireAuth. */
export const requireRole =
  (...roles: Array<"OWNER" | "ADMIN" | "AGENT">): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.admin) return next(unauthorized());
    if (!roles.includes(req.admin.role)) {
      return next(forbidden("Your role can't perform this action."));
    }
    next();
  };

/** Shopper routes that act on a specific order: /api/portal/* */
export const requirePortalSession: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const token = bearer(req) ?? req.cookies?.portal_token ?? null;
  if (!token) {
    return next(unauthorized("Look up your order to continue."));
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return next(
      unauthorized("Your session has expired. Look up your order again."),
    );
  }

  req.portal = payload;
  next();
};
