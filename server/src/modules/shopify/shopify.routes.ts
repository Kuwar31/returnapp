import express, { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { isValidShopDomain } from "./shopify.client.js";
import { verifyOAuthHmac, verifyWebhookHmac } from "./shopify.hmac.js";
import {
  authorizeUrl,
  exchangeCodeForToken,
  newNonce,
  NONCE_COOKIE,
  provisionMerchant,
  registerWebhooks,
} from "./shopify.install.js";
import { backfillOrders } from "./order.sync.js";
import { handleWebhook } from "./webhook.handlers.js";

export const shopifyRouter = Router();

const requireConfigured = () => {
  if (!env.shopifyConfigured) {
    throw badRequest(
      "Shopify isn't configured on this server. Set SHOPIFY_API_KEY, " +
        "SHOPIFY_API_SECRET and ENCRYPTION_KEY.",
    );
  }
};

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

const installSchema = z.object({
  shop: z.string().refine(isValidShopDomain, "Enter a valid .myshopify.com domain"),
});

/** Entry point for installing the app on a store. */
shopifyRouter.get(
  "/install",
  rateLimit({ windowMs: 60_000, max: 20 }),
  validate(installSchema, "query"),
  asyncHandler(async (req, res) => {
    requireConfigured();
    const { shop } = req.query as unknown as z.infer<typeof installSchema>;

    const nonce = newNonce();
    // The nonce lives in a cookie so the callback can prove this redirect
    // started here, not on an attacker's page.
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: 10 * 60_000,
    });

    res.redirect(authorizeUrl(shop, nonce));
  }),
);

shopifyRouter.get(
  "/callback",
  rateLimit({ windowMs: 60_000, max: 20 }),
  asyncHandler(async (req, res) => {
    requireConfigured();

    const { shop, code, state } = req.query as Record<string, string>;

    if (!shop || !isValidShopDomain(shop) || !code) {
      throw badRequest("Shopify sent an incomplete callback.");
    }
    if (!verifyOAuthHmac(req.query as Record<string, unknown>)) {
      throw unauthorized("Could not verify this request came from Shopify.");
    }
    const expected = req.cookies?.[NONCE_COOKIE];
    if (!expected || expected !== state) {
      throw unauthorized("Authorization state didn't match. Start again.");
    }
    res.clearCookie(NONCE_COOKIE);

    const { access_token, scope } = await exchangeCodeForToken(shop, code);
    const merchant = await provisionMerchant(shop, access_token, scope);

    await registerWebhooks(shop, access_token);

    // The backfill can take a while on a busy store, so don't make the
    // merchant stare at a redirect while it runs.
    void backfillOrders(merchant.id).catch((error) =>
      logger.error({ shop, error }, "Backfill failed after install"),
    );

    const target = new URL("/admin", env.corsOrigins[0] ?? env.APP_URL);
    target.searchParams.set("connected", merchant.slug);
    res.redirect(target.toString());
  }),
);

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * HMAC is computed over the exact bytes Shopify sent, so this route needs the
 * raw body — it must not go through the JSON parser first.
 */
shopifyRouter.post(
  "/webhooks",
  express.raw({ type: "application/json", limit: "2mb" }),
  asyncHandler(async (req, res) => {
    if (!env.shopifyConfigured) {
      res.status(503).json({ error: "Shopify not configured" });
      return;
    }

    const raw = req.body as Buffer;
    const hmac = req.header("X-Shopify-Hmac-Sha256");
    const topic = req.header("X-Shopify-Topic");
    const shop = req.header("X-Shopify-Shop-Domain");
    const webhookId = req.header("X-Shopify-Webhook-Id");

    if (!verifyWebhookHmac(raw, hmac)) {
      logger.warn({ topic, shop }, "Rejected webhook with invalid HMAC");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }
    if (!topic || !shop) {
      res.status(400).json({ error: "Missing topic or shop header" });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "Malformed JSON" });
      return;
    }

    // Process before acknowledging: our writes are sub-second, and a non-2xx
    // makes Shopify retry, which is exactly what we want on a transient error.
    await handleWebhook({ topic, shop, webhookId, payload });
    res.status(200).json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Merchant-facing connection status
// ---------------------------------------------------------------------------

shopifyRouter.get(
  "/connection",
  requireAuth,
  asyncHandler(async (req, res) => {
    const integration = await prisma.integration.findFirst({
      where: { merchantId: req.admin!.merchantId, provider: "SHOPIFY" },
    });
    const orderCount = await prisma.order.count({
      where: { merchantId: req.admin!.merchantId },
    });

    res.json({
      configured: env.shopifyConfigured,
      connected: Boolean(integration?.active),
      shop: integration?.externalShopId ?? null,
      scopes: integration?.scopes ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastSyncedAt: integration?.lastSyncedAt ?? null,
      orderCount,
    });
  }),
);

const backfillSchema = z.object({
  days: z.number().int().positive().max(365).default(90),
});

/** Lets a merchant re-pull orders without reinstalling. */
shopifyRouter.post(
  "/sync",
  requireAuth,
  requireRole("OWNER", "ADMIN"),
  validate(backfillSchema),
  asyncHandler(async (req, res) => {
    requireConfigured();
    const result = await backfillOrders(req.admin!.merchantId, {
      days: req.body.days,
    });
    res.json(result);
  }),
);
