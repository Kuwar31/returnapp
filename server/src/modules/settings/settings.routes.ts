import { Router } from "express";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";

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
  allowExchange: boolean;
  allowInstantExchange: boolean;
  bonusCreditPercent: unknown;
  restockingFeePercent: unknown;
  returnShippingFee: unknown;
  waiveShippingOnCredit: boolean;
  autoApprove: boolean;
  autoApproveUnder: unknown;
}) => ({
  ...policy,
  bonusCreditPercent: Number(policy.bonusCreditPercent),
  restockingFeePercent: Number(policy.restockingFeePercent),
  returnShippingFee: Number(policy.returnShippingFee),
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
  allowExchange: z.boolean(),
  allowInstantExchange: z.boolean(),
  bonusCreditPercent: z.number().min(0).max(100),
  restockingFeePercent: z.number().min(0).max(100),
  returnShippingFee: z.number().min(0),
  waiveShippingOnCredit: z.boolean(),
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

settingsRouter.get(
  "/reasons",
  asyncHandler(async (req, res) => {
    const reasons = await prisma.returnReason.findMany({
      where: { merchantId: req.admin!.merchantId },
      orderBy: { sortOrder: "asc" },
    });
    res.json(reasons);
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
