import { Router } from "express";
import { z } from "zod";
import { FONT_KEYS } from "./portal-fonts.js";
import { LOCALE_CODES } from "./portal-locales.js";
import { notFound } from "../../lib/errors.js";
import { portalUrl } from "../../lib/portal-links.js";
import { prisma } from "../../lib/prisma.js";
import {
  listNotificationSettings,
  resolveSender,
  setNotificationEnabled,
} from "./notification-settings.js";
import { asyncHandler } from "../../middleware/asyncHandler.js";
import { requireRole } from "../../middleware/auth.js";
import { validate } from "../../middleware/validate.js";
import { SHOPIFY_RETURN_REASONS } from "../shopify/returns.graphql.js";
import * as reasonsService from "./reasons.service.js";
import * as exchangeRules from "./exchange-rules.service.js";
import { browseCollections } from "../shopify/catalogue.service.js";
import { clearMerchantSettingsCache } from "./merchant-settings.js";

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
/**
 * Store-level preferences that aren't part of a return policy.
 *
 * Display currency lives here rather than on the policy because it's about how
 * the app presents money, not about what a shopper is entitled to.
 */
settingsRouter.get(
  "/store",
  asyncHandler(async (req, res) => {
    const merchant = await prisma.merchant.findUniqueOrThrow({
      where: { id: req.admin!.merchantId },
      select: {
        name: true,
        slug: true,
        currency: true,
        displayCurrency: true,
        exchangeMethod: true,
        shopNowEnabled: true,
        shopNowMode: true,
        shopNowBonusAmount: true,
        domain: true,
        variantExchangeDifference: true,
        shopNowBonusType: true,
        exchangeBonusType: true,
        exchangeBonusValue: true,
      },
    });

    // What PRESENTMENT would actually resolve to, so the UI can name the
    // currency instead of saying "the customer's currency".
    const sample = await prisma.order.findFirst({
      where: {
        merchantId: req.admin!.merchantId,
        presentmentCurrency: { not: null },
      },
      select: { presentmentCurrency: true },
      orderBy: { placedAt: "desc" },
    });

    res.json({
      ...merchant,
      presentmentCurrency: sample?.presentmentCurrency ?? null,
      // Decimal doesn't survive JSON as a number; every other money field on
      // this API is a number, so this one is too.
      shopNowBonusAmount:
        merchant.shopNowBonusAmount === null
          ? null
          : Number(merchant.shopNowBonusAmount),
      exchangeBonusValue:
        merchant.exchangeBonusValue === null
          ? null
          : Number(merchant.exchangeBonusValue),
      /**
       * The whole link, not the slug. The merchant pastes this into a footer or
       * a policy page, so the client shouldn't be assembling it out of a path
       * and its own origin — the portal isn't necessarily served from wherever
       * the admin happens to be open.
       */
      portalUrl: portalUrl(merchant.slug),
      /**
       * The same portal, reached through Shopify's app proxy so it renders
       * inside the merchant's own theme. Null until a store is connected,
       * since there is no storefront to serve it from.
       */
      storefrontUrl: merchant.domain
        ? `https://${merchant.domain}/apps/returns`
        : null,
    });
  }),
);

settingsRouter.patch(
  "/store",
  validate(
    z
      .object({
        displayCurrency: z.enum(["SHOP", "PRESENTMENT"]).optional(),
        exchangeMethod: z.enum(["DRAFT_ORDER", "SHOPIFY_NATIVE"]).optional(),
        shopNowEnabled: z.boolean().optional(),
        shopNowMode: z.enum(["RETURNS_PAGE", "STOREFRONT"]).optional(),
        /** Null clears the flat bonus; the percentage one still applies. */
        shopNowBonusAmount: z.number().min(0).max(100000).nullable().optional(),
        variantExchangeDifference: z
          .enum(["SAME_PRICE_ONLY", "CHARGE", "ABSORB"])
          .optional(),
        shopNowBonusType: z.enum(["PERCENT", "FIXED"]).optional(),
        exchangeBonusType: z.enum(["PERCENT", "FIXED"]).optional(),
        /** Null clears it, which falls back to the policy's percentage. */
        exchangeBonusValue: z.number().min(0).max(100000).nullable().optional(),
      })
      .refine((v) => Object.keys(v).length > 0, {
        message: "Nothing to update.",
      }),
  ),
  asyncHandler(async (req, res) => {
    const merchant = await prisma.merchant.update({
      where: { id: req.admin!.merchantId },
      // Both optional, so a request that names one setting leaves the other
      // alone rather than resetting it to a default the merchant never chose.
      data: {
        ...(req.body.displayCurrency
          ? { displayCurrency: req.body.displayCurrency }
          : {}),
        ...(req.body.exchangeMethod
          ? { exchangeMethod: req.body.exchangeMethod }
          : {}),
        ...(req.body.shopNowEnabled === undefined
          ? {}
          : { shopNowEnabled: req.body.shopNowEnabled }),
        ...(req.body.shopNowMode ? { shopNowMode: req.body.shopNowMode } : {}),
        ...(req.body.shopNowBonusAmount === undefined
          ? {}
          : { shopNowBonusAmount: req.body.shopNowBonusAmount }),
        ...(req.body.variantExchangeDifference
          ? { variantExchangeDifference: req.body.variantExchangeDifference }
          : {}),
        ...(req.body.shopNowBonusType
          ? { shopNowBonusType: req.body.shopNowBonusType }
          : {}),
        ...(req.body.exchangeBonusType
          ? { exchangeBonusType: req.body.exchangeBonusType }
          : {}),
        ...(req.body.exchangeBonusValue === undefined
          ? {}
          : { exchangeBonusValue: req.body.exchangeBonusValue }),
      },
      select: {
        currency: true,
        displayCurrency: true,
        exchangeMethod: true,
        shopNowEnabled: true,
        shopNowMode: true,
        variantExchangeDifference: true,
        shopNowBonusType: true,
        exchangeBonusType: true,
      },
    });
    // The resolver caches for 30s; drop it so the change shows immediately.
    clearMerchantSettingsCache(req.admin!.merchantId);
    res.json(merchant);
  }),
);

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

const hex = (label: string) =>
  z.string().regex(/^#[0-9a-fA-F]{6}$/, `Use a hex colour like ${label}`);

/**
 * An optional image address.
 *
 * Empty string maps to null rather than failing: a merchant clearing a logo
 * empties the box, and telling them "" is not a valid URL is answering a
 * question they didn't ask.
 */
const imageUrl = z
  .union([z.string().url(), z.literal(""), z.null()])
  .transform((v) => (v ? v : null));

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .transform((v) => (v ? v : null));

const brandingSchema = z.object({
  headline: z.string().trim().min(1).max(120),
  subheadline: z.string().trim().max(200),
  logoUrl: imageUrl,
  accentColor: hex("#111213"),
  supportEmail: z
    .union([z.string().trim().email(), z.literal(""), z.null()])
    .transform((v) => (v ? v : null)),
  policyUrl: z.union([z.string().url(), z.literal(""), z.null()]).transform((v) => (v ? v : null)),

  // Theme
  textTone: z.enum(["DARK", "LIGHT"]),
  cornerRadius: z.enum(["SHARP", "CURVED", "ROUNDED"]),
  backgroundColor: hex("#f5f5f6"),
  heroImageUrl: imageUrl,

  // Branding
  lightLogoUrl: imageUrl,
  logoWidth: z.number().int().min(60).max(480),
  faviconUrl: imageUrl,
  headingFont: z.enum(FONT_KEYS),
  headingColor: hex("#1a1a1c"),
  bodyFont: z.enum(FONT_KEYS),
  bodyColor: hex("#5f6368"),
  // Null means "use the accent colour", which is what buttons did before.
  buttonColor: z.union([hex("#111213"), z.literal(""), z.null()]).transform((v) => (v ? v : null)),
  buttonTextColor: hex("#ffffff"),
  suggestionColor: hex("#6d5ce7"),

  // Content
  orderNumberLabel: z.string().trim().min(1).max(60),
  emailLabel: z.string().trim().min(1).max(60),
  lookupHelpText: optionalText(300),
  startButtonLabel: z.string().trim().min(1).max(40),
  footerHeading: optionalText(60),
  footerText: optionalText(300),

  searchEngineVisible: z.boolean(),
  locale: z.enum(LOCALE_CODES),
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

// ---------------------------------------------------------------------------
// Customer notifications — which emails a store sends, and who they're from
// ---------------------------------------------------------------------------

/**
 * The catalogue and the store's answers in one payload, plus the sender.
 *
 * The labels come from the server because the set of notifications is a fact
 * about what the app sends, not a list the admin should be keeping its own
 * copy of.
 */
settingsRouter.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    const [notifications, sender] = await Promise.all([
      listNotificationSettings(req.admin!.merchantId),
      resolveSender(req.admin!.merchantId),
    ]);
    res.json({ notifications, sender });
  }),
);

const notificationsSchema = z
  .object({
    /** Only the switches that changed; anything unnamed keeps its answer. */
    notifications: z
      .array(
        z.object({
          kind: z.enum([
            "SUBMITTED",
            "APPROVED",
            "EDITED",
            "DECLINED",
            "REMINDER",
            "EXPIRING",
            "EXPIRED",
            "RECEIVED",
            "RESOLVED",
          ]),
          enabled: z.boolean(),
        }),
      )
      .max(20)
      .optional(),
    /** Blank clears it, which falls back to the store's own name. */
    senderName: z.string().trim().max(80).nullable().optional(),
    /** Where replies land. Null removes the header entirely. */
    replyTo: z.string().trim().email().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update." });

settingsRouter.patch(
  "/notifications",
  validate(notificationsSchema),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const body = req.body as z.infer<typeof notificationsSchema>;

    for (const { kind, enabled } of body.notifications ?? []) {
      await setNotificationEnabled(merchantId, kind, enabled);
    }

    if (body.senderName !== undefined) {
      await prisma.merchant.update({
        where: { id: merchantId },
        // An empty box means "use the store's name", not a store called "".
        data: { senderName: body.senderName || null },
      });
    }

    /**
     * The reply address is the portal's support address — the same one the
     * shopper sees on the returns page. Kept as one field rather than two
     * because a store answering returns from two different mailboxes
     * depending on whether the customer clicked or replied is a trap.
     */
    if (body.replyTo !== undefined) {
      await prisma.portalBranding.upsert({
        where: { merchantId },
        update: { supportEmail: body.replyTo },
        create: { merchantId, supportEmail: body.replyTo },
      });
    }

    const [notifications, sender] = await Promise.all([
      listNotificationSettings(merchantId),
      resolveSender(merchantId),
    ]);
    res.json({ notifications, sender });
  }),
);

// ---------------------------------------------------------------------------
// Advanced exchanges — which lists a returned item may be swapped into
// ---------------------------------------------------------------------------

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean().optional(),
  matchBy: z.enum(["PRODUCT_TAG", "PRODUCT_NAME"]).optional(),
  matchValues: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
  showProductTitles: z.boolean().optional(),
  bonusType: z.enum(["PERCENT", "FIXED"]).optional(),
  /** Null clears the override, falling back to the store-wide bonus. */
  bonusValue: z.number().min(0).max(100000).nullable().optional(),
  options: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(80),
        collectionId: z.string().trim().min(1).max(200),
        collectionTitle: z.string().trim().min(1).max(200),
      }),
    )
    .max(10)
    .optional(),
});

settingsRouter.get(
  "/exchange-rules",
  asyncHandler(async (req, res) => {
    res.json({
      rules: await exchangeRules.listRules(req.admin!.merchantId),
      /** The collections an option can point at, for the editor's picker. */
      collections: await browseCollections(req.admin!.merchantId),
    });
  }),
);

settingsRouter.post(
  "/exchange-rules",
  validate(ruleSchema),
  asyncHandler(async (req, res) => {
    res
      .status(201)
      .json(await exchangeRules.createRule(req.admin!.merchantId, req.body));
  }),
);

settingsRouter.patch(
  "/exchange-rules/:id",
  validate(ruleSchema),
  asyncHandler(async (req, res) => {
    res.json(
      await exchangeRules.updateRule(
        req.admin!.merchantId,
        req.params.id,
        req.body,
      ),
    );
  }),
);

settingsRouter.delete(
  "/exchange-rules/:id",
  asyncHandler(async (req, res) => {
    await exchangeRules.deleteRule(req.admin!.merchantId, req.params.id);
    res.status(204).end();
  }),
);

/** Priority is only meaningful as an order, so it is set for the whole set. */
settingsRouter.post(
  "/exchange-rules/reorder",
  validate(z.object({ ids: z.array(z.string().min(1)).max(100) })),
  asyncHandler(async (req, res) => {
    await exchangeRules.reorderRules(req.admin!.merchantId, req.body.ids);
    res.json({ rules: await exchangeRules.listRules(req.admin!.merchantId) });
  }),
);
