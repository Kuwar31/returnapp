import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { serializeReturn, serializeReturnSummary } from "./serializers.js";
import * as returnsService from "./returns.service.js";
import { resolveDisplayMode } from "../settings/merchant-settings.js";

export const returnsRouter = Router();

const listQuerySchema = z.object({
  status: z
    .enum([
      "DRAFT",
      "SUBMITTED",
      "APPROVED",
      "REJECTED",
      "IN_TRANSIT",
      "RECEIVED",
      "RESOLVED",
      "CANCELLED",
      "EXPIRED",
    ])
    .optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

returnsRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;
    const result = await returnsService.listReturns(req.admin!.merchantId, query);
    const display = await resolveDisplayMode(req.admin!.merchantId);
    res.json({
      ...result,
      items: result.items.map((r) => serializeReturnSummary(r, display)),
    });
  }),
);

returnsRouter.get(
  "/stats",
  asyncHandler(async (req, res) => {
    res.json(await returnsService.getDashboardStats(req.admin!.merchantId));
  }),
);

returnsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const request = await returnsService.getReturn(
      req.admin!.merchantId,
      req.params.id,
    );
    // Sidebar context the return itself doesn't carry: who this shopper is to
    // the store, and which policy the request was judged against.
    const [shopper, merchant, payout] = await Promise.all([
      returnsService.getShopperStats(
        req.admin!.merchantId,
        request.customerEmail,
      ),
      prisma.merchant.findUnique({
        where: { id: req.admin!.merchantId },
        select: { slug: true },
      }),
      returnsService.getPayoutBreakdown(req.admin!.merchantId, req.params.id),
    ]);
    res.json({
      ...serializeReturn(request, await resolveDisplayMode(req.admin!.merchantId)),
      shopper,
      payout,
      policyName: request.policy?.name ?? null,
      portalSlug: merchant?.slug ?? null,
    });
  }),
);

returnsRouter.post(
  "/:id/approve",
  asyncHandler(async (req, res) => {
    const updated = await returnsService.approveReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

const rejectSchema = z.object({
  reason: z.string().trim().min(1, "Tell the customer why").max(500),
});

returnsRouter.post(
  "/:id/reject",
  validate(rejectSchema),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.rejectReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.reason,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

returnsRouter.post(
  "/:id/receive",
  asyncHandler(async (req, res) => {
    const updated = await returnsService.markReceived(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

// Paying out money is owner/admin territory.
returnsRouter.post(
  "/:id/resolve",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.resolveReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

/**
 * Preview what resolving will pay out, straight from Shopify.
 *
 * Lets a merchant see the exact refund — taxes, discounts and prior refunds
 * accounted for — before committing, which is the reassurance Shopify's own
 * "Process and refund" screen provides.
 */
returnsRouter.get(
  "/:id/refund-preview",
  asyncHandler(async (req, res) => {
    const preview = await returnsService.previewRefund(
      req.admin!.merchantId,
      req.params.id,
    );
    res.json(preview);
  }),
);

/**
 * Receive and resolve in one action — the equivalent of Shopify's
 * "Process and refund", so the merchant never has to leave this app.
 */
returnsRouter.post(
  "/:id/process",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.processAndRefund(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

const reasonOnlySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/**
 * Withdraw the request without judging it.
 *
 * Separate from reject: a rejection is a decision the customer is told about,
 * a cancellation just takes the request off the board — raised in error,
 * duplicated, or settled another way.
 */
returnsRouter.post(
  "/:id/cancel",
  requireRole("OWNER", "ADMIN"),
  validate(reasonOnlySchema),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.cancelReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.reason,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

/** Toggles the "needs a second look" flag. Any role can raise one. */
returnsRouter.post(
  "/:id/flag",
  validate(reasonOnlySchema),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.flagReturn(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.reason,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

const inspectSchema = z
  .object({
    /** Null clears the decision and puts the line back to uninspected. */
    acceptedQuantity: z.number().int().min(0).max(999).nullable().optional(),
    restock: z.boolean().optional(),
    rejectionNote: z.string().trim().max(500).nullable().optional(),
    /** "Change to keep" — credit the shopper without asking for the item back. */
    keepItem: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Nothing to update.",
  });

/** Unit-level inspection: accept some, all or none of a line's units. */
returnsRouter.patch(
  "/:id/line-items/:lineItemId",
  requireRole("OWNER", "ADMIN"),
  validate(inspectSchema),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.inspectLineItem(
      req.admin!.merchantId,
      req.params.id,
      req.params.lineItemId,
      req.admin!.sub,
      req.body,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

/** Retries the exchange draft order when the automatic attempt failed. */
returnsRouter.post(
  "/:id/exchange/retry",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.retryExchangeDraftOrder(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

/** Re-sends the exchange checkout link when the shopper never got the first. */
returnsRouter.post(
  "/:id/exchange/invoice",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.resendExchangeInvoice(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

const noteSchema = z.object({
  message: z.string().trim().min(1).max(1000),
});

returnsRouter.post(
  "/:id/notes",
  validate(noteSchema),
  asyncHandler(async (req, res) => {
    const event = await returnsService.addNote(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.message,
    );
    res.status(201).json({
      id: event.id,
      type: event.type,
      message: event.message,
      createdAt: event.createdAt,
    });
  }),
);
