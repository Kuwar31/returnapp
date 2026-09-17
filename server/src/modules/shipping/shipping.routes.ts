import { Router } from "express";
import { logger } from "../../lib/logger.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { packingSlipHtml } from "../returns/packing-slip.js";
import {
  handleExternalEvent,
  handleEasyPostWebhook,
  handleSendcloudWebhook,
  handleShippoWebhook,
  handleWebhook,
  hostedLabelPdf,
  testLabelHtml,
} from "./shipping.service.js";

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

/** A label PDF the app hosts for a carrier that handed one over. Signed link, as the test label. */
shippingRouter.get(
  "/label/:id",
  asyncHandler(async (req, res) => {
    const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
    const pdf = await hostedLabelPdf(req.params.id, sig);
    if (!pdf) {
      res.status(404).type("text/plain").send("No such label.");
      return;
    }
    res.type("application/pdf").setHeader("content-disposition", `inline; filename="return-label-${req.params.id}.pdf"`).send(pdf);
  }),
);

/** The packing slip, printable. Signed link, as the label. */
shippingRouter.get(
  "/packing-slip/:id",
  asyncHandler(async (req, res) => {
    const sig = typeof req.query.sig === "string" ? req.query.sig : undefined;
    const html = await packingSlipHtml(req.params.id, sig);
    if (!html) {
      res.status(404).type("text/plain").send("No such packing slip.");
      return;
    }
    res.type("text/html").send(html);
  }),
);

/**
 * What the store's own connector sends back: the label for a return it was
 * asked about, or where the parcel is. Authenticated by the store's
 * connector secret in `x-api-key`; the body names the return.
 */
shippingRouter.post(
  "/external/events",
  asyncHandler(async (req, res) => {
    const key = req.header("x-api-key") ?? req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? undefined;
    const result = await handleExternalEvent(key, req.body);
    if (result === "unauthorized") {
      res.status(401).json({ error: "Unknown return or wrong secret" });
      return;
    }
    res.json({ ok: true, result });
  }),
);

/** Sendcloud's parcel-status webhook, signed over the raw body with the account's secret key. */
shippingRouter.post(
  "/sendcloud/events",
  asyncHandler(async (req, res) => {
    const raw = (req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await handleSendcloudWebhook(raw, req.header("sendcloud-signature") ?? undefined, req.body);
    if (result === "unauthorized") {
      res.status(401).json({ error: "Bad signature" });
      return;
    }
    res.json({ ok: true, result });
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

/**
 * EasyPost's tracker webhook. Signed over the raw body with the secret the
 * merchant pasted into EasyPost; the parcel names the store, and the
 * store's secret checks the signature.
 */
shippingRouter.post(
  "/easypost/events",
  asyncHandler(async (req, res) => {
    const raw = (req as typeof req & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const result = await handleEasyPostWebhook(raw, req.header("x-hmac-signature") ?? undefined, req.body);
    if (result === "unauthorized") {
      res.status(401).json({ error: "Bad signature" });
      return;
    }
    res.json({ ok: true, result });
  }),
);

/** Shippo's tracking webhook: unsigned, so the URL's token names the store. */
shippingRouter.post(
  "/shippo/events",
  asyncHandler(async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : undefined;
    const result = await handleShippoWebhook(token, req.body);
    if (result === "unauthorized") {
      res.status(401).json({ error: "Unknown webhook token" });
      return;
    }
    res.json({ ok: true, result });
  }),
);
