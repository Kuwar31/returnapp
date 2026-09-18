import type { CustomerTokenPayload, PortalTokenPayload } from "../lib/tokens.js";
import type { ResolvedMembership } from "../modules/auth/membership.js";

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by requireAuth — who is signed in, and which of their stores this
       * request acts on. The store comes from the request rather than the
       * token, but it is always re-read from the database before it lands here.
       */
      admin?: ResolvedMembership & { sub: string };
      /** Set by requirePortalSession — the shopper's verified order scope. */
      portal?: PortalTokenPayload;
      /** Set by requireCustomerSession — a shopper signed in to the storefront, vouched for by Shopify. */
      customer?: CustomerTokenPayload;
    }
  }
}

export {};
