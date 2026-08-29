import { Router } from "express";
import { z } from "zod";
import { notFound, unauthorized } from "../../lib/errors.js";
import { signPortalToken } from "../../lib/tokens.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requirePortalSession } from "../../middleware/auth.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { serializeReturn } from "../returns/serializers.js";
import {
  feedbackSchema,
  lookupSchema,
  quoteSchema,
  referenceAuthSchema,
  submitSchema,
} from "./portal.schemas.js";
import * as portalService from "./portal.service.js";
import { resolveDisplayMode } from "../settings/merchant-settings.js";
import {
  backfillExchangeItemImages,
  getExchangePaymentUrl,
  refreshExchangeDraft,
} from "../shopify/exchange.service.js";

export const portalRouter = Router();

/** Store branding and copy — drives the portal's look before login. */
portalRouter.get(
  "/:slug/config",
  asyncHandler(async (req, res) => {
    const merchant = await portalService.getMerchantBySlug(req.params.slug);
    const heroImageUrl = await portalService.resolveHeroImage(merchant.id);

    res.json({
      merchant: {
        slug: merchant.slug,
        name: merchant.name,
        currency: merchant.currency,
      },
      branding: {
        headline: merchant.branding?.headline ?? "Returns & Exchanges",
        subheadline:
          merchant.branding?.subheadline ??
          "Start a return or exchange in a few clicks",
        logoUrl: merchant.branding?.logoUrl ?? null,
        heroImageUrl,
        accentColor: merchant.branding?.accentColor ?? "#111213",
        supportEmail: merchant.branding?.supportEmail ?? null,
        policyUrl: merchant.branding?.policyUrl ?? null,
      },
    });
  }),
);

/**
 * Order lookup is the only unauthenticated write path, so it's the one worth
 * rate limiting — otherwise it's an order-number oracle.
 */
portalRouter.post(
  "/lookup",
  rateLimit({ windowMs: 15 * 60_000, max: 10 }),
  validate(lookupSchema),
  asyncHandler(async (req, res) => {
    const { merchantSlug, orderNumber, email } = req.body;
    const merchant = await portalService.getMerchantBySlug(merchantSlug);
    const order = await portalService.lookupOrder(
      merchant.id,
      orderNumber,
      email,
    );

    if (!order) {
      // Deliberately vague: don't confirm whether the order exists.
      throw notFound(
        "We couldn't find an order matching that number and email.",
      );
    }

    const token = signPortalToken({
      merchantId: merchant.id,
      orderId: order.id,
      email: order.email,
    });

    res.json({ token, orderId: order.id });
  }),
);

portalRouter.use("/session", requirePortalSession);

/** Everything the item-selection screen needs in one call. */
portalRouter.get(
  "/session/order",
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const { order, policy, reasonGroups, eligibility } =
      await portalService.getOrderEligibility(merchantId, orderId);

    res.json({
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        email: order.email,
        customerName: order.customerName,
        currency: order.currency,
        placedAt: order.placedAt,
      },
      policy: {
        windowDays: policy.returnWindowDays,
        bonusCreditPercent: Number(policy.bonusCreditPercent),
        restockingFeePercent: Number(policy.restockingFeePercent),
      },
      /**
       * Reason trees, one per group in play on this order. Each eligible item
       * carries the id of the group that applies to it.
       *
       * `code` is deliberately not sent — it's the Shopify mapping, internal to
       * the merchant, and the shopper picks by id.
       */
      reasonGroups: reasonGroups.map((g) => ({
        id: g.id,
        reasons: g.reasons.map((r) => ({
          id: r.id,
          label: r.label,
          requiresNote: r.requiresNote,
          requiresPhoto: r.requiresPhoto,
          children: r.children.map((c) => ({
            id: c.id,
            label: c.label,
            requiresNote: c.requiresNote,
            requiresPhoto: c.requiresPhoto,
          })),
        })),
      })),
      eligibility,
    });
  }),
);

/**
 * Sibling variants of an item the shopper already has — "exchange for a new
 * size". Scoped to the portal session, so it only ever exposes products the
 * merchant sells, and only to someone who proved they own an order.
 */
portalRouter.get(
  "/session/exchange/variants",
  validate(z.object({ orderLineItemId: z.string().min(1) }), "query"),
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const options = await portalService.getExchangeOptions(
      merchantId,
      orderId,
      String(req.query.orderLineItemId),
    );
    res.json(options);
  }),
);

/** Browsable catalogue for "exchange for another product". */
portalRouter.get(
  "/session/exchange/products",
  rateLimit({ windowMs: 60_000, max: 60 }),
  validate(
    z.object({
      search: z.string().trim().max(100).optional(),
      cursor: z.string().optional(),
    }),
    "query",
  ),
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const query = req.query as { search?: string; cursor?: string };
    // Scoped to the order, not just the merchant: catalogue prices convert at
    // that order's own rate, so the browse needs to know which one.
    const result = await portalService.browseExchangeProducts(
      merchantId,
      orderId,
      query,
    );
    res.json(result);
  }),
);

/**
 * Display details for variants already chosen, so a draft saved before a field
 * existed can fill itself in rather than making the shopper choose again.
 */
portalRouter.get(
  "/session/exchange/variant-info",
  validate(z.object({ ids: z.string().min(1).max(2000) }), "query"),
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const ids = String(req.query.ids).split(",").filter(Boolean).slice(0, 50);
    res.json(
      await portalService.describeExchangeVariants(merchantId, orderId, ids),
    );
  }),
);

/** Live totals as the shopper changes items or resolution. */
portalRouter.post(
  "/session/quote",
  validate(quoteSchema),
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const quote = await portalService.quoteSelection(
      merchantId,
      orderId,
      req.body,
    );
    res.json(quote);
  }),
);

portalRouter.post(
  "/session/returns",
  validate(submitSchema),
  asyncHandler(async (req, res) => {
    const { merchantId, orderId } = req.portal!;
    const created = await portalService.submitReturn(
      merchantId,
      orderId,
      req.body,
    );
    res.status(201).json(
      serializeReturn(created, await resolveDisplayMode(merchantId)),
    );
  }),
);

type ReferenceAuth = z.infer<typeof referenceAuthSchema>;

/** Status page — reachable from the confirmation email without a session. */
portalRouter.get(
  "/returns/:reference",
  rateLimit({ windowMs: 15 * 60_000, max: 30 }),
  validate(referenceAuthSchema, "query"),
  asyncHandler(async (req, res) => {
    const { slug, email } = req.query as ReferenceAuth;
    const merchant = await portalService.getMerchantBySlug(slug);
    const found = await portalService.getReturnByReference(
      merchant.id,
      req.params.reference,
      email,
    );
    if (!found) {
      throw unauthorized("That return reference and email don't match.");
    }

    /**
     * Reconcile, then re-read. A shopper arriving straight from checkout is the
     * likeliest visitor to this page, and showing them "Pay now" for something
     * they have just paid for is the worst thing it could say.
     */
    await refreshExchangeDraft(merchant.id, found.id);
    const request =
      (await portalService.getReturnByReference(
        merchant.id,
        req.params.reference,
        email,
      )) ?? found;

    // Repairs pictures stored before the product-image fallback existed. Fire
    // and forget: it must never delay or fail the page it decorates.
    void backfillExchangeItemImages(merchant.id, request.id);
    res.json({
      ...serializeReturn(request, await resolveDisplayMode(merchant.id)),
      // Only present when a native exchange actually leaves a balance owed.
      exchangePayment: await getExchangePaymentUrl(merchant.id, request.id),
    });
  }),
);

/**
 * "Cancel return" on the confirmation page.
 *
 * Same reference + email proof as the status read, and rate limited on top:
 * cancellation is destructive enough that a leaked link shouldn't also make it
 * cheap to guess references.
 */
portalRouter.post(
  "/returns/:reference/cancel",
  rateLimit({ windowMs: 15 * 60_000, max: 10 }),
  validate(referenceAuthSchema, "query"),
  asyncHandler(async (req, res) => {
    const { slug, email } = req.query as ReferenceAuth;
    const merchant = await portalService.getMerchantBySlug(slug);
    const request = await portalService.cancelReturnByReference(
      merchant.id,
      req.params.reference,
      email,
    );
    if (!request) {
      throw unauthorized("That return reference and email don't match.");
    }
    res.json(serializeReturn(request, await resolveDisplayMode(merchant.id)));
  }),
);

/** The post-submission survey in the confirmation page's sidebar. */
portalRouter.post(
  "/returns/:reference/feedback",
  rateLimit({ windowMs: 15 * 60_000, max: 20 }),
  validate(referenceAuthSchema, "query"),
  validate(feedbackSchema),
  asyncHandler(async (req, res) => {
    const { slug, email } = req.query as ReferenceAuth;
    const merchant = await portalService.getMerchantBySlug(slug);
    const request = await portalService.saveReturnFeedback(
      merchant.id,
      req.params.reference,
      email,
      req.body,
    );
    if (!request) {
      throw unauthorized("That return reference and email don't match.");
    }
    res.json(serializeReturn(request, await resolveDisplayMode(merchant.id)));
  }),
);
