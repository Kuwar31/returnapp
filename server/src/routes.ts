import { Router } from "express";
import { prisma } from "./lib/prisma.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { requireAuth } from "./middleware/auth.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { portalRouter } from "./modules/portal/portal.routes.js";
import { returnsRouter } from "./modules/returns/returns.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { proxyRouter } from "./modules/shopify/proxy.routes.js";
import { shopifyRouter } from "./modules/shopify/shopify.routes.js";

export const apiRouter = Router();

/** Liveness + database reachability, for container health checks. */
apiRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", uptime: process.uptime() });
  }),
);

// Shopify OAuth and webhooks. Authenticates via Shopify's own signatures,
// so it sits outside both the admin and portal auth schemes.
apiRouter.use("/shopify", shopifyRouter);

/**
 * The storefront app proxy: Shopify forwards <shop>/apps/returns here and
 * renders the reply inside the merchant's theme. Signed by Shopify, like the
 * routes above, and outside every other auth scheme.
 */
apiRouter.use("/proxy", proxyRouter);

// Shopper-facing. No admin auth; sessions are scoped to one order.
apiRouter.use("/portal", portalRouter);

// Merchant-facing.
apiRouter.use("/auth", authRouter);
apiRouter.use("/admin/returns", requireAuth, returnsRouter);
apiRouter.use("/admin/settings", requireAuth, settingsRouter);
