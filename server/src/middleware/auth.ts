import type { NextFunction, Request, RequestHandler, Response } from "express";
import { forbidden, unauthorized } from "../lib/errors.js";
import { verifyAdminToken, verifyPortalToken } from "../lib/tokens.js";
import { resolveMembership } from "../modules/auth/membership.js";

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
};

/**
 * Names the store this request acts on, by portal slug.
 *
 * A header rather than a path segment because it is orthogonal to what the
 * route does: every admin endpoint needs a store, and threading `:slug` through
 * all of them would say the same thing seventy-odd times. The client fills it
 * in from its own URL, so the address bar stays the single source of truth for
 * which store is on screen.
 */
export const STORE_HEADER = "x-store-slug";

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

  const header = req.header(STORE_HEADER);
  const slug = typeof header === "string" && header.trim() ? header.trim() : null;

  void resolveMembership(payload.sub, slug)
    .then((membership) => {
      if (!membership) {
        /**
         * Deliberately the same answer whether the store doesn't exist, was
         * suspended, or simply isn't one of yours — the admin shouldn't be a
         * way to test which slugs are taken.
         */
        return next(
          slug
            ? forbidden("You don't have access to that store.")
            : unauthorized("Your account has no active stores."),
        );
      }
      req.admin = { sub: payload.sub, ...membership };
      next();
    })
    .catch(next);
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
