import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { handleWebhook } from "./shiprocket.service.js";

export const shippingRouter = Router();

/**
 * Shiprocket's tracking webhook.
 *
 * Authenticated by the `x-api-key` header, which carries the secret the
 * merchant pasted into their Shiprocket settings and which names their
 * store. The path deliberately says nothing about Shiprocket: their webhook
 * form rejects URLs that mention it.
 *
 * Answers 200 to anything it could read, as Shiprocket asks: a parcel it
 * doesn't know is theirs to keep sending about, not an error.
 */
shippingRouter.post(
  "/events",
  asyncHandler(async (req, res) => {
    const key = req.header("x-api-key") ?? undefined;
    const result = await handleWebhook(key, req.body);
    if (result === "unauthorized") {
      logger.warn("Rejected a shipping webhook with an unknown key");
      res.status(401).json({ error: "Unknown webhook token" });
      return;
    }
    res.json({ ok: true, result });
  }),
);
