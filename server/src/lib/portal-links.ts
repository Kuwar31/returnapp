import { env } from "../config/env.js";

/**
 * Absolute links into the shopper-facing portal.
 *
 * Built in one place because separate callers have to agree on them: the
 * settings screen hands the merchant a URL to paste into their site footer, and
 * the confirmation email sends a shopper to their own return. If those two ever
 * disagreed, one of them would be quietly sending customers nowhere.
 *
 * The base is PORTAL_BASE_URL, falling back to the first CORS origin — the
 * client allowed to call this API is, by definition, where the portal is
 * served from. This is also the seam a custom domain would go through later:
 * per-merchant hosts change these two functions and nothing else.
 */

/** Trailing slashes in the configured base would double up in every link. */
const base = (): string => env.portalBaseUrl.replace(/\/+$/, "");

/** A store's portal front door — the link a merchant shares with customers. */
export const portalUrl = (slug: string): string => `${base()}/r/${slug}`;

/**
 * One shopper's return, openable straight from the inbox: the reference and
 * email in the URL are what authorise the read, so it needs no portal session.
 */
export const returnStatusUrl = (
  slug: string,
  reference: string,
  email: string,
): string =>
  `${portalUrl(slug)}/status/${reference}?email=${encodeURIComponent(email)}`;
