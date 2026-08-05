import type { AdminTokenPayload, PortalTokenPayload } from "../lib/tokens.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth — the signed-in merchant staff member. */
      admin?: AdminTokenPayload;
      /** Set by requirePortalSession — the shopper's verified order scope. */
      portal?: PortalTokenPayload;
    }
  }
}

export {};
