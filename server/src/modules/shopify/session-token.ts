import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";
import { unauthorized } from "../../lib/errors.js";

/**
 * The session token a Shopify UI extension sends with a request to this
 * app: a JWT signed with the app's shared secret, naming the shop it came
 * from and, when the shopper is signed in, the shopper. Verifying it is
 * what lets an extension call this API without any login of its own.
 */
export interface ExtensionSession {
  /** The store, as its permanent myshopify.com domain. */
  shopDomain: string;
  /** The signed-in customer's GID, when there is one. */
  customerId: string | null;
}

export const verifyExtensionSessionToken = (token: string | undefined): ExtensionSession => {
  if (!token) throw unauthorized("Missing session token.");
  if (!env.SHOPIFY_API_SECRET || !env.SHOPIFY_API_KEY) throw unauthorized("Shopify isn't configured on this server.");
  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, env.SHOPIFY_API_SECRET, {
      algorithms: ["HS256"],
      audience: env.SHOPIFY_API_KEY,
      // Shopify's clock and this one can disagree by a few seconds.
      clockTolerance: 15,
    }) as jwt.JwtPayload;
  } catch {
    throw unauthorized("The session token isn't valid.");
  }
  const dest = typeof payload.dest === "string" ? payload.dest : "";
  let shopDomain: string;
  try {
    shopDomain = new URL(dest).hostname.toLowerCase();
  } catch {
    throw unauthorized("The session token names no store.");
  }
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain)) throw unauthorized("The session token names no store.");
  const sub = typeof payload.sub === "string" && payload.sub.startsWith("gid://shopify/Customer/") ? payload.sub : null;
  return { shopDomain, customerId: sub };
};
