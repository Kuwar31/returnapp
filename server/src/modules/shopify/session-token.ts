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
  } catch (error) {
    /**
     * Said precisely, because the fix differs: a bad signature means the
     * server's SHOPIFY_API_SECRET isn't the secret of the app the extension
     * was deployed from; a wrong audience means SHOPIFY_API_KEY isn't its key.
     * Neither is secret, and the token came from Shopify, so naming what was
     * seen costs nothing.
     */
    const seen = jwt.decode(token) as jwt.JwtPayload | null;
    const detail =
      error instanceof jwt.TokenExpiredError
        ? "it has expired"
        : error instanceof jwt.JsonWebTokenError && /audience/i.test(error.message)
          ? `it was issued for app ${String(seen?.aud ?? "?")}, not this one (${env.SHOPIFY_API_KEY})`
          : error instanceof jwt.JsonWebTokenError && /signature/i.test(error.message)
            ? "its signature doesn't match this server's SHOPIFY_API_SECRET"
            : error instanceof Error
              ? error.message
              : "it couldn't be read";
    throw unauthorized(`The session token isn't valid: ${detail}.`);
  }
  // The store is named as a URL in dest, and as its admin URL in iss; take whichever carries the permanent domain.
  const hosts = [payload.dest, payload.iss]
    .filter((v): v is string => typeof v === "string")
    .map((v) => {
      try {
        return new URL(v).hostname.toLowerCase();
      } catch {
        return "";
      }
    });
  const shopDomain = hosts.find((h) => /^[a-z0-9-]+\.myshopify\.com$/.test(h));
  if (!shopDomain) throw unauthorized(`The session token names no store (saw ${hosts.filter(Boolean).join(", ") || "nothing"}).`);
  const sub = typeof payload.sub === "string" && payload.sub.startsWith("gid://shopify/Customer/") ? payload.sub : null;
  return { shopDomain, customerId: sub };
};
