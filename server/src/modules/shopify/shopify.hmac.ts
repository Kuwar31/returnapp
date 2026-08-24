import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

const secret = (): string => {
  if (!env.SHOPIFY_API_SECRET) {
    throw new Error("SHOPIFY_API_SECRET is not set.");
  }
  return env.SHOPIFY_API_SECRET;
};

/**
 * Verifies the `hmac` query parameter Shopify appends to OAuth redirects.
 * Every parameter except `hmac` participates, sorted by key.
 */
export const verifyOAuthHmac = (
  query: Record<string, unknown>,
): boolean => {
  const { hmac, ...rest } = query;
  if (typeof hmac !== "string") return false;

  const message = Object.keys(rest)
    .sort()
    .map((key) => `${key}=${String(rest[key])}`)
    .join("&");

  const digest = createHmac("sha256", secret()).update(message).digest();
  const provided = Buffer.from(hmac, "hex");
  const ok =
    provided.length === digest.length && timingSafeEqual(digest, provided);

  if (!ok) {
    // A signature mismatch is otherwise completely opaque — it looks identical
    // whether the secret is wrong, the server is holding a stale one, or the
    // signed message was assembled differently. Log everything except the
    // secret itself, plus a short fingerprint so a stale process is visible.
    logger.warn(
      {
        signedMessage: message,
        expected: digest.toString("hex"),
        received: hmac,
        secretFingerprint: createHash("sha256")
          .update(secret())
          .digest("hex")
          .slice(0, 12),
        secretLength: secret().length,
      },
      "OAuth HMAC mismatch",
    );
  }

  return ok;
};

/**
 * Verifies the X-Shopify-Hmac-Sha256 header on a webhook. Must run against the
 * exact raw request body — any JSON re-serialization changes the bytes and
 * invalidates the signature.
 */
export const verifyWebhookHmac = (
  rawBody: Buffer,
  header: string | undefined,
): boolean => {
  if (!header) return false;
  const digest = createHmac("sha256", secret()).update(rawBody).digest();
  const provided = Buffer.from(header, "base64");
  if (provided.length !== digest.length) return false;
  return timingSafeEqual(digest, provided);
};
