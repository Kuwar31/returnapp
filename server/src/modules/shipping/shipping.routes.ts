import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { handleWebhook, testLabelHtml } from "./shiprocket.service.js";

export const shippingRouter = Router();

/**
 * A test-mode label, as a printable page. Reached from the label link in
 * the shopper's email and status page, so it's public — guarded by the
 * signature in the link rather than a login.
 */
shippingRouter.get(
  "/test-label/:id",
  asyncHandler(async (req, res) => {
    const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
    const html = await testLabelHtml(req.params.id, sig);
    if (!html) {
      res.status(404).type("text/plain").send("No such label.");
      return;
    }
    res.type("text/html").send(html);
  }),
);

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
