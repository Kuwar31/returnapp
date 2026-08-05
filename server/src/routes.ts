import { Router } from "express";
import { prisma } from "./lib/prisma.js";
import { asyncHandler } from "./middleware/asyncHandler.js";
import { requireAuth } from "./middleware/auth.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { portalRouter } from "./modules/portal/portal.routes.js";
import { returnsRouter } from "./modules/returns/returns.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";

export const apiRouter = Router();

/** Liveness + database reachability, for container health checks. */
apiRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: "ok", uptime: process.uptime() });
  }),
);

// Shopper-facing. No admin auth; sessions are scoped to one order.
apiRouter.use("/portal", portalRouter);

// Merchant-facing.
apiRouter.use("/auth", authRouter);
apiRouter.use("/admin/returns", requireAuth, returnsRouter);
apiRouter.use("/admin/settings", requireAuth, settingsRouter);
