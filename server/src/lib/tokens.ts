import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export interface AdminTokenPayload {
  sub: string;
  merchantId: string;
  role: "OWNER" | "ADMIN" | "AGENT";
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
