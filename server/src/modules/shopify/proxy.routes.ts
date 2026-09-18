import { Router } from "express";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { portalUrl } from "../../lib/portal-links.js";
import { prisma } from "../../lib/prisma.js";
import { signCustomerToken } from "../../lib/tokens.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { verifyProxySignature } from "./shopify.hmac.js";

export const proxyRouter = Router();

/**
 * The returns portal, served inside the merchant's own storefront.
 *
 * Shopify forwards `https://<shop>/apps/returns` here and renders whatever
 * comes back — and when the response is `application/liquid`, it renders it
 * *inside the store's theme*, header, footer and all. That is the whole reason
 * to use a proxy rather than a link: the shopper never leaves the shop, the
 * page is on the merchant's own domain, and there is no DNS, no certificate
 * and no subdomain to set up. It is how Loop does this.
 *
 * The portal itself is a separate single-page app on its own origin, so it
 * arrives in a frame. Rendering it any other way would mean serving the SPA's
 * routing and assets through Liquid, which buys nothing and breaks the portal
 * when opened directly.
 */

/** Escapes a value being written into HTML text or an attribute. */
const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );

/**
 * The framed portal, plus just enough script to keep it the right height.
 *
 * An iframe cannot size itself to its content across origins, so the portal
 * measures itself and posts its height out; this listens for that and resizes.
 * Messages are checked against the portal's own origin — anything else on the
 * page can post too.
 *
 * The width is asked for twice on purpose. A theme decides how the content
 * area is laid out, and Horizon centres it in a container that shrinks to
 * fit its contents: there `width: 100%` resolves to nothing and the frame
 * fell back to an iframe's built-in 300px, drawing the portal's phone layout
 * in the middle of a desktop page. The `width` attribute gives the frame an
 * intrinsic size the container has to make room for, and the CSS caps it at
 * whatever room there is.
 */
const embedPage = (src: string, origin: string): string => `
<div id="returns-portal-embed" style="display:block;width:100%;max-width:1100px;margin:0 auto;padding:0 16px;box-sizing:border-box">
  <iframe
    id="returns-portal-frame"
    src="${escapeHtml(src)}"
    title="Returns and exchanges"
    width="1068"
    height="720"
    style="width:1068px;max-width:100%;min-height:720px;border:0;display:block"
    allow="clipboard-write"
  ></iframe>
</div>
<script>
(function () {
  var frame = document.getElementById("returns-portal-frame");
  if (!frame) return;
  window.addEventListener("message", function (event) {
    if (event.origin !== ${JSON.stringify(origin)}) return;
    var data = event.data;
    if (!data || data.type !== "returns-portal:height") return;
    var height = Number(data.height);
    // A bad number would collapse the frame to nothing; ignore it and keep
    // whatever height the portal last reported.
    if (!isFinite(height) || height < 200) return;
    frame.style.height = Math.ceil(height) + "px";
  });
})();
</script>
`;

proxyRouter.get(
  "*",
  asyncHandler(async (req, res) => {
    if (!env.shopifyConfigured) {
      res.status(503).type("text/plain").send("Returns are not configured.");
      return;
    }

    const query = req.query as Record<string, unknown>;
    if (!verifyProxySignature(query)) {
      logger.warn({ shop: query.shop }, "Rejected app proxy request");
      res.status(401).type("text/plain").send("Invalid signature.");
      return;
    }

    const shop = typeof query.shop === "string" ? query.shop : null;
    const merchant = shop
      ? await prisma.merchant.findFirst({
          where: { domain: shop, status: "ACTIVE" },
          select: { id: true, slug: true },
        })
      : null;

    if (!merchant) {
      // Signed by Shopify, so the request is genuine — this store just isn't
      // set up here. Said plainly rather than as a 404 the shopper can't act on.
      res
        .status(404)
        .type("application/liquid")
        .send("<p>Returns aren't set up for this store yet.</p>");
      return;
    }

    /**
     * Anything after the proxy subpath is handed to the portal, so
     * /apps/returns/status/R-ABC123 opens that return rather than the lookup.
     */
    const suffix = req.path === "/" ? "" : req.path;
    const target = new URL(`${portalUrl(merchant.slug)}${suffix}`);
    target.searchParams.set("embedded", "1");
    for (const [key, value] of Object.entries(query)) {
      // Shopify's own proxy parameters are noise to the portal.
      if (["signature", "shop", "path_prefix", "timestamp", "logged_in_customer_id"].includes(key)) {
        continue;
      }
      if (typeof value === "string") target.searchParams.set(key, value);
    }

    /**
     * A shopper signed in to the storefront is named by Shopify on the
     * request, under the same signature checked above, so the portal can
     * greet them with their orders instead of a form — as AfterShip's and
     * Loop's returns centres do. The id can't go across as-is: the portal's
     * API would then trust whatever number a URL carried. It goes across as
     * a token this server signed, which the API verifies like any other.
     */
    const customerId = typeof query.logged_in_customer_id === "string" ? query.logged_in_customer_id : "";
    if (/^\d+$/.test(customerId)) {
      target.searchParams.set(
        "customer",
        signCustomerToken({ merchantId: merchant.id, customerExternalId: `gid://shopify/Customer/${customerId}` }),
      );
    }

    res
      .status(200)
      .type("application/liquid")
      .send(embedPage(target.toString(), new URL(portalUrl(merchant.slug)).origin));
  }),
);
