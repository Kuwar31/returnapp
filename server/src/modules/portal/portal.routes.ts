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
  lookupSchema,
  quoteSchema,
  submitSchema,
} from "./portal.schemas.js";
import * as portalService from "./portal.service.js";

export const portalRouter = Router();

/** Store branding and copy — drives the portal's look before login. */
portalRouter.get(
  "/:slug/config",
  asyncHandler(async (req, res) => {
    const merchant = await portalService.getMerchantBySlug(req.params.slug);
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
    const { order, policy, reasons, eligibility } =
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
        returnShippingFee: Number(policy.returnShippingFee),
        waiveShippingOnCredit: policy.waiveShippingOnCredit,
      },
      reasons: reasons.map((r) => ({
        code: r.code,
        label: r.label,
        requiresNote: r.requiresNote,
        requiresPhoto: r.requiresPhoto,
      })),
      eligibility,
    });
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
    res.status(201).json(serializeReturn(created));
  }),
);

const statusQuerySchema = z.object({
  slug: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
});

/** Status page — reachable from the confirmation email without a session. */
portalRouter.get(
  "/returns/:reference",
  rateLimit({ windowMs: 15 * 60_000, max: 30 }),
  validate(statusQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const { slug, email } = req.query as z.infer<typeof statusQuerySchema>;
    const merchant = await portalService.getMerchantBySlug(slug);
    const request = await portalService.getReturnByReference(
      merchant.id,
      req.params.reference,
      email,
    );
    if (!request) {
      throw unauthorized("That return reference and email don't match.");
    }
    res.json(serializeReturn(request));
  }),
);
