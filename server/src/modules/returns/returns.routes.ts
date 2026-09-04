import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { serializeReturn, serializeReturnSummary } from "./serializers.js";
import * as returnsService from "./returns.service.js";
import { resolveDisplayMode } from "../settings/merchant-settings.js";
import {
  diagnoseExchange,
  runExchangeRepair,
} from "../shopify/exchange-repair.service.js";
import {
  backfillExchangeItemImages,
  getExchangePaymentUrl,
  refreshExchangeDraft,
} from "../shopify/exchange.service.js";

export const returnsRouter = Router();

const STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "RESOLVED",
  "CANCELLED",
  "EXPIRED",
] as const;

const RESOLUTIONS = [
  "REFUND",
  "STORE_CREDIT",
  "EXCHANGE",
  "GIFT_CARD",
  "INSTANT_EXCHANGE",
  "WARRANTY",
] as const;

/**
 * A comma-separated list in one query parameter.
 *
 * `?status=APPROVED,RECEIVED` rather than repeating the key, because it
 * survives a round trip through URLSearchParams unchanged — the admin keeps its
 * filters in the address bar, and a shape that reads back the way it was
 * written is one less thing to reconcile.
 */
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw
        ? raw
            .split(",")
            .map((v) => v.trim().toUpperCase())
            .filter(Boolean)
        : undefined,
    )
    .pipe(z.array(z.enum(values)).max(values.length).optional());

/**
 * The same comma-separated shape, for values we don't own the set of.
 *
 * Shopify's own tag input treats a comma as the separator, so a tag can't
 * contain one — which is what makes this safe to split on.
 */
const csvFree = z
  .string()
  .optional()
  .transform((raw) =>
    raw
      ? raw
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
          .slice(0, 25)
      : undefined,
  );

export const listQuerySchema = z.object({
  status: csv(STATUSES),
  resolution: csv(RESOLUTIONS),
  tags: csvFree,
  search: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  flagged: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(25),
});

returnsRouter.get(
  "/",
  validate(listQuerySchema, "query"),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as z.infer<typeof listQuerySchema>;
    /**
     * A date with no time means the whole of that day.
     *
     * "to: 2 September" reads as "up to and including today", but coercing it
     * lands on midnight, which would exclude every return submitted since.
     */
    const to = query.to;
    if (to && to.getUTCHours() === 0 && to.getUTCMinutes() === 0) {
      to.setUTCHours(23, 59, 59, 999);
    }
    const result = await returnsService.listReturns(req.admin!.merchantId, {
      ...query,
      to,
    });
    const display = await resolveDisplayMode(req.admin!.merchantId);
    res.json({
      ...result,
      items: result.items.map((r) => serializeReturnSummary(r, display)),
    });
  }),
);

/**
 * The tags available to filter by. Sits above `/:id` so the dynamic route
 * doesn't claim the word "tags" as a return id.
 */
returnsRouter.get(
  "/tags",
  asyncHandler(async (req, res) => {
    res.json({ tags: await returnsService.listReturnedProductTags(req.admin!.merchantId) });
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
    /**
     * Before reading, not after: this can mark a draft paid, and the record is
     * serialized straight into the response — fetching first would render the
     * state we were about to correct.
     */
    await refreshExchangeDraft(req.admin!.merchantId, req.params.id);

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
    const exchangePayment = await getExchangePaymentUrl(
      req.admin!.merchantId,
      req.params.id,
    );

    // Repairs pictures stored before the product-image fallback existed. Fire
    // and forget: it must never delay or fail the page it decorates.
    void backfillExchangeItemImages(req.admin!.merchantId, req.params.id);
    res.json({
      ...serializeReturn(request, await resolveDisplayMode(req.admin!.merchantId)),
      shopper,
      payout,
      exchangePayment,
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

const LOCATION_GID = /^gid:\/\/shopify\/Location\/\d+$/;

/**
 * "Restock all" in one call rather than one per line, so a return with a
 * dozen items doesn't become a dozen requests racing to recompute the same
 * totals.
 */
returnsRouter.post(
  "/:id/restock-all",
  requireRole("OWNER", "ADMIN"),
  validate(z.object({ restock: z.boolean() })),
  asyncHandler(async (req, res) => {
    const updated = await returnsService.setRestockAll(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
      req.body.restock,
    );
    res.json(serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)));
  }),
);

const inspectSchema = z
  .object({
    /** Null clears the decision and puts the line back to uninspected. */
    acceptedQuantity: z.number().int().min(0).max(999).nullable().optional(),
    restock: z.boolean().optional(),
    /** A Shopify Location id; null means the store's default location. */
    restockLocationId: z.string().regex(LOCATION_GID).nullable().optional(),
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

/**
 * Diagnoses an exchange that Shopify settled wrong. Read-only, so the detail
 * page can ask on every render without side effects.
 */
returnsRouter.get(
  "/:id/exchange/diagnose",
  asyncHandler(async (req, res) => {
    res.json(
      await diagnoseExchange(req.admin!.merchantId, req.params.id),
    );
  }),
);

/** Commits a stranded exchange and nets it against the return. */
returnsRouter.post(
  "/:id/exchange/repair",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    const diagnosis = await runExchangeRepair(
      req.admin!.merchantId,
      req.params.id,
      req.admin!.sub,
    );
    const updated = await returnsService.getReturn(
      req.admin!.merchantId,
      req.params.id,
    );
    res.json({
      ...serializeReturn(updated, await resolveDisplayMode(req.admin!.merchantId)),
      diagnosis,
    });
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
