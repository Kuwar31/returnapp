import express, { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { decrypt } from "../../lib/crypto.js";
import { badRequest, unauthorized } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireAuth, requireRole } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { signInstallToken, verifyInstallToken } from "../../lib/tokens.js";
import { getShopCredentials, isValidShopDomain } from "./shopify.client.js";
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
  shop: z
    .string()
    .trim()
    .toLowerCase()
    // Accept "acme" as shorthand for "acme.myshopify.com".
    .transform((v) =>
      v.endsWith(".myshopify.com") ? v : `${v.replace(/\..*$/, "")}.myshopify.com`,
    )
    .refine(isValidShopDomain, "Enter a valid .myshopify.com domain"),
});

/**
 * Begins an install for the signed-in merchant account. Returns the URL rather
 * than redirecting, because the browser must navigate at the top level and a
 * fetch can't carry the admin token through a redirect chain.
 *
 * The merchant id rides along in the signed `state` so the callback links the
 * store to this account instead of creating an orphan one with no users.
 */
shopifyRouter.post(
  "/install-url",
  requireAuth,
  requireRole("OWNER", "ADMIN"),
  rateLimit({ windowMs: 60_000, max: 20 }),
  validate(installSchema),
  asyncHandler(async (req, res) => {
    requireConfigured();
    const { shop } = req.body as z.infer<typeof installSchema>;

    const nonce = newNonce();
    const state = signInstallToken({
      merchantId: req.admin!.merchantId,
      shop,
      nonce,
    });

    // The nonce cookie proves the callback belongs to a flow that started here,
    // not on a page an attacker sent the merchant to.
    res.cookie(NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: env.isProduction,
      maxAge: 10 * 60_000,
    });

    res.json({ url: authorizeUrl(shop, state) });
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

    // `state` came back via Shopify, so it is untrusted until the signature
    // checks out — and the nonce inside it must match the cookie we set.
    const install = state ? verifyInstallToken(state) : null;
    if (!install) {
      throw unauthorized(
        "This authorization link is invalid or has expired. Start again.",
      );
    }
    if (install.shop !== shop) {
      throw unauthorized("Authorization was started for a different store.");
    }
    /**
     * The nonce cookie is a secondary check, not the primary one.
     *
     * It is set on the origin the browser called to start the install, but
     * Shopify returns to APP_URL — a different host whenever a tunnel or a
     * separate API domain is in play, so the browser rightly withholds it.
     * Requiring it would make OAuth impossible in exactly those setups.
     *
     * CSRF protection comes from `state` itself: it is signed with our own
     * secret, expires in ten minutes, and names both the merchant and the
     * shop, all of which were verified above. An attacker cannot mint one.
     * When the cookie does arrive it must still match.
     */
    const cookieNonce = req.cookies?.[NONCE_COOKIE];
    if (cookieNonce && cookieNonce !== install.nonce) {
      throw unauthorized("Authorization state didn't match. Start again.");
    }
    res.clearCookie(NONCE_COOKIE);

    const { access_token, scope } = await exchangeCodeForToken(shop, code);
    const merchant = await provisionMerchant(
      shop,
      access_token,
      scope,
      install.merchantId,
    );

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

    // Distinguish "never connected" from "connected but credentials are no
    // longer readable", so the UI can explain what happened.
    let needsReconnect = false;
    if (integration?.accessToken) {
      try {
        decrypt(integration.accessToken);
      } catch {
        needsReconnect = true;
      }
    }

    res.json({
      configured: env.shopifyConfigured,
      connected: Boolean(integration?.active) && !needsReconnect,
      needsReconnect,
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

/**
 * Re-pulls orders without reinstalling, and re-registers webhooks first.
 *
 * Registration happens at install, so anything that failed then — most often
 * because protected customer data access hadn't been granted yet — would stay
 * broken forever otherwise. Re-registering is idempotent, so it is safe to
 * repeat on every sync.
 */
shopifyRouter.post(
  "/sync",
  requireAuth,
  requireRole("OWNER", "ADMIN"),
  validate(backfillSchema),
  asyncHandler(async (req, res) => {
    requireConfigured();
    const merchantId = req.admin!.merchantId;

    const { shop, accessToken } = await getShopCredentials(merchantId);
    await registerWebhooks(shop, accessToken);

    const result = await backfillOrders(merchantId, { days: req.body.days });
    res.json(result);
  }),
);
