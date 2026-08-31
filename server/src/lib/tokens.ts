import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

/**
 * Names the person, not the store they happen to be looking at.
 *
 * The store used to be baked in here, which meant switching had to re-issue the
 * token — and since the token lives in one localStorage slot, two tabs open on
 * two stores would fight over it and each would silently start showing the
 * other's data. The active store now travels per request (see
 * `resolveMembership`), so a tab is scoped by its own URL and nothing global
 * has to change to move between stores.
 *
 * The trade: a stolen token reaches every store this account belongs to rather
 * than one. That is the same reach the account itself has, and the previous
 * design only narrowed it until the thief called /auth/switch.
 */
export interface AdminTokenPayload {
  sub: string;
}

/**
 * Issued after a shopper proves they own an order (order number + email).
 * Scopes every portal request to that one order — no account needed.
 */
export interface PortalTokenPayload {
  merchantId: string;
  orderId: string;
  email: string;
}

/**
 * Carried through the Shopify OAuth round trip in the `state` parameter so the
 * callback knows which merchant account started the install. Signed because it
 * travels via Shopify and comes back as untrusted input.
 */
export interface InstallTokenPayload {
  /**
   * Who started the install, not which store they were looking at.
   *
   * A person connecting their second shop is adding a store, not re-pointing
   * the one on screen, so the callback needs to know the human — it grants them
   * membership of whichever merchant the shop resolves to.
   */
  userId: string;
  /** The store they were viewing, claimed only if it has no domain yet. */
  merchantId: string;
  shop: string;
  nonce: string;
}

export const signInstallToken = (payload: InstallTokenPayload): string =>
  jwt.sign({ ...payload, kind: "install" }, env.JWT_SECRET, {
    expiresIn: "10m",
  });

export const signAdminToken = (payload: AdminTokenPayload): string =>
  jwt.sign({ ...payload, kind: "admin" }, env.JWT_SECRET, {
    expiresIn: "12h",
  });

export const signPortalToken = (payload: PortalTokenPayload): string =>
  jwt.sign({ ...payload, kind: "portal" }, env.JWT_SECRET, {
    expiresIn: `${env.PORTAL_TOKEN_TTL_MINUTES}m`,
  });

const verify = <T>(
  token: string,
  kind: "admin" | "portal" | "install",
): T | null => {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as Record<
      string,
      unknown
    >;
    if (decoded.kind !== kind) return null;
    return decoded as T;
  } catch {
    return null;
  }
};

export const verifyAdminToken = (token: string) =>
  verify<AdminTokenPayload>(token, "admin");

export const verifyPortalToken = (token: string) =>
  verify<PortalTokenPayload>(token, "portal");

export const verifyInstallToken = (token: string) =>
  verify<InstallTokenPayload>(token, "install");
