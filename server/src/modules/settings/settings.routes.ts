import { Router } from "express";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { SHOPIFY_RETURN_REASONS } from "../shopify/returns.graphql.js";
import * as reasonsService from "./reasons.service.js";

export const settingsRouter = Router();

// Only owners and admins change policy — agents just process returns.
settingsRouter.use(requireRole("OWNER", "ADMIN"));

const serializePolicy = (policy: {
  id: string;
  name: string;
  isDefault: boolean;
  active: boolean;
  returnWindowDays: number;
  windowStartsFrom: string;
  allowFinalSale: boolean;
  requirePhotoProof: boolean;
  allowRefund: boolean;
  allowStoreCredit: boolean;
  allowGiftCard: boolean;
  allowExchange: boolean;
  allowInstantExchange: boolean;
  bonusCreditPercent: unknown;
  restockingFeePercent: unknown;
  autoApprove: boolean;
  autoApproveUnder: unknown;
}) => ({
  ...policy,
  bonusCreditPercent: Number(policy.bonusCreditPercent),
  restockingFeePercent: Number(policy.restockingFeePercent),
  autoApproveUnder:
    policy.autoApproveUnder === null ? null : Number(policy.autoApproveUnder),
});

settingsRouter.get(
  "/policies",
  asyncHandler(async (req, res) => {
    const policies = await prisma.returnPolicy.findMany({
      where: { merchantId: req.admin!.merchantId },
      orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    });
    res.json(policies.map(serializePolicy));
  }),
);

const policySchema = z.object({
  name: z.string().trim().min(1).max(80),
  returnWindowDays: z.number().int().min(1).max(365),
  windowStartsFrom: z.enum(["ORDER_DATE", "FULFILLMENT", "DELIVERY"]),
  allowFinalSale: z.boolean(),
  requirePhotoProof: z.boolean(),
  allowRefund: z.boolean(),
  allowStoreCredit: z.boolean(),
  allowGiftCard: z.boolean(),
  allowExchange: z.boolean(),
  allowInstantExchange: z.boolean(),
  bonusCreditPercent: z.number().min(0).max(100),
  restockingFeePercent: z.number().min(0).max(100),
  autoApprove: z.boolean(),
  autoApproveUnder: z.number().min(0).nullable(),
});

settingsRouter.patch(
  "/policies/:id",
  validate(policySchema.partial()),
  asyncHandler(async (req, res) => {
    const existing = await prisma.returnPolicy.findFirst({
      where: { id: req.params.id, merchantId: req.admin!.merchantId },
    });
    if (!existing) throw notFound("Policy not found.");

    const updated = await prisma.returnPolicy.update({
      where: { id: existing.id },
      data: req.body,
    });
    res.json(serializePolicy(updated));
  }),
);

/**
 * Reason groups with their full trees — what the settings screen renders.
 *
 * Returned whole rather than paged: a merchant has a handful of groups and a
 * few dozen reasons, and editing them is much easier against one payload than
 * against a lazily-loaded tree.
 */
settingsRouter.get(
  "/reason-groups",
  asyncHandler(async (req, res) => {
    res.json({
      groups: await reasonsService.listGroups(req.admin!.merchantId),
      /** The only codes Shopify accepts; the editor offers exactly these. */
      shopifyCodes: [...SHOPIFY_RETURN_REASONS].sort(),
    });
  }),
);

const groupSchema = z.object({
  title: z.string().trim().min(1).max(80),
  productTypes: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
  randomizeOrder: z.boolean().optional(),
});

settingsRouter.post(
  "/reason-groups",
  requireRole("OWNER", "ADMIN"),
  validate(groupSchema),
  asyncHandler(async (req, res) => {
    const group = await reasonsService.createGroup(
      req.admin!.merchantId,
      req.body,
    );
    res.status(201).json(group);
  }),
);

settingsRouter.patch(
  "/reason-groups/:id",
  requireRole("OWNER", "ADMIN"),
  validate(groupSchema.partial()),
  asyncHandler(async (req, res) => {
    res.json(
      await reasonsService.updateGroup(
        req.admin!.merchantId,
        req.params.id,
        req.body,
      ),
    );
  }),
);

settingsRouter.delete(
  "/reason-groups/:id",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    await reasonsService.deleteGroup(req.admin!.merchantId, req.params.id);
    res.status(204).end();
  }),
);

const reasonSchema = z.object({
  groupId: z.string().min(1),
  parentId: z.string().min(1).nullable().optional(),
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(120),
  requiresNote: z.boolean().optional(),
  requiresPhoto: z.boolean().optional(),
});

settingsRouter.post(
  "/reasons",
  requireRole("OWNER", "ADMIN"),
  validate(reasonSchema),
  asyncHandler(async (req, res) => {
    const reason = await reasonsService.createReason(
      req.admin!.merchantId,
      req.body,
    );
    res.status(201).json(reason);
  }),
);

settingsRouter.patch(
  "/reasons/:id",
  requireRole("OWNER", "ADMIN"),
  validate(
    reasonSchema
      .omit({ groupId: true, parentId: true })
      .partial()
      .extend({
        active: z.boolean().optional(),
        sortOrder: z.number().int().min(0).max(999).optional(),
      }),
  ),
  asyncHandler(async (req, res) => {
    res.json(
      await reasonsService.updateReason(
        req.admin!.merchantId,
        req.params.id,
        req.body,
      ),
    );
  }),
);

settingsRouter.delete(
  "/reasons/:id",
  requireRole("OWNER", "ADMIN"),
  asyncHandler(async (req, res) => {
    res.json(
      await reasonsService.deleteReason(req.admin!.merchantId, req.params.id),
    );
  }),
);

const brandingSchema = z.object({
  headline: z.string().trim().min(1).max(120),
  subheadline: z.string().trim().max(200),
  logoUrl: z.string().url().nullable(),
  accentColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Use a hex color like #111213"),
  supportEmail: z.string().email().nullable(),
  policyUrl: z.string().url().nullable(),
});

settingsRouter.get(
  "/branding",
  asyncHandler(async (req, res) => {
    const branding = await prisma.portalBranding.upsert({
      where: { merchantId: req.admin!.merchantId },
      update: {},
      create: { merchantId: req.admin!.merchantId },
    });
    res.json(branding);
  }),
);

settingsRouter.put(
  "/branding",
  validate(brandingSchema.partial()),
  asyncHandler(async (req, res) => {
    const branding = await prisma.portalBranding.upsert({
      where: { merchantId: req.admin!.merchantId },
      update: req.body,
      create: { merchantId: req.admin!.merchantId, ...req.body },
    });
    res.json(branding);
  }),
);
