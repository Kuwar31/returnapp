import { Router } from "express";
import { z } from "zod";
import { FONT_KEYS } from "./portal-fonts.js";
import { LOCALE_CODES } from "./portal-locales.js";
import { notFound, unprocessable } from "../../lib/errors.js";
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
import * as regionalPolicies from "./regional-policies.service.js";
import * as destinationsService from "./destinations.service.js";
import * as routing from "./routing.service.js";
import * as shiprocket from "../shipping/shiprocket.service.js";
import * as delhivery from "../shipping/delhivery.service.js";
import * as easypost from "../shipping/easypost.service.js";
import * as shippo from "../shipping/shippo.service.js";
import * as shipstation from "../shipping/shipstation.service.js";
import * as sendcloud from "../shipping/sendcloud.service.js";
import * as dhlexpress from "../shipping/dhlexpress.service.js";
import * as fedex from "../shipping/fedex.service.js";
import * as auspost from "../shipping/auspost.service.js";
import * as dhlparcelde from "../shipping/dhlparcelde.service.js";
import * as external from "../shipping/external.service.js";
import * as packageSizes from "./package-sizes.service.js";
import { canWriteOrders, listOrderNoteRules, ORDER_NOTE_PLACEHOLDERS, setOrderNoteRule } from "../shopify/order-notes.service.js";
import { LABEL_REFERENCE_TYPES, MAX_LABEL_REFERENCES } from "../shipping/label-references.js";
import * as shippingSettings from "../shipping/shipping.settings.js";
import { indianMobile } from "../shipping/addresses.js";
import { inventoryAccessProblem } from "../shopify/locations.service.js";
import { browseCollections } from "../shopify/catalogue.service.js";
import { listLocationsIfConnected } from "../shopify/locations.service.js";
import { phoneAccessProblem } from "../shopify/order.sync.js";
import { normalizeCriteria } from "../portal/lookup-match.js";
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
  tagRulesEnabled: boolean;
  finalSaleTags: string[];
  exchangeOnlyTags: string[];
  allowExchangeOfExchange: boolean;
  sequentialExchangeLimit: number | null;
  matchStoreAvailability: boolean;
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
  allowExchangeOfExchange: z.boolean(),
  /** Null is "no limit"; a number caps how far the chain runs. */
  sequentialExchangeLimit: z.number().int().min(1).max(10).nullable(),
  matchStoreAvailability: z.boolean(),
  tagRulesEnabled: z.boolean(),
  /**
   * Tags are trimmed and de-duplicated but not lowercased on the way in: the
   * merchant sees back exactly what they typed, and matching lowercases both
   * sides at comparison time instead.
   */
  finalSaleTags: z
    .array(z.string().trim().min(1).max(80))
    .max(25)
    .transform((tags) => [...new Set(tags)]),
  exchangeOnlyTags: z
    .array(z.string().trim().min(1).max(80))
    .max(25)
    .transform((tags) => [...new Set(tags)]),
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
        restockLocationId: true,
        aiExchangeEnabled: true,
        similarExchangeEnabled: true,
        inventoryLocationIds: true,
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
        /** Null means the location each order was fulfilled from. */
        restockLocationId: z
          .string()
          .regex(/^gid:\/\/shopify\/Location\/\d+$/)
          .nullable()
          .optional(),
        aiExchangeEnabled: z.boolean().optional(),
        similarExchangeEnabled: z.boolean().optional(),
        /** Empty means every location counts for exchange availability. */
        inventoryLocationIds: z
          .array(z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/))
          .max(50)
          .transform((ids) => [...new Set(ids)])
          .optional(),
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
        ...(req.body.restockLocationId === undefined
          ? {}
          : { restockLocationId: req.body.restockLocationId }),
        ...(req.body.aiExchangeEnabled === undefined
          ? {}
          : { aiExchangeEnabled: req.body.aiExchangeEnabled }),
        ...(req.body.similarExchangeEnabled === undefined
          ? {}
          : { similarExchangeEnabled: req.body.similarExchangeEnabled }),
        ...(req.body.inventoryLocationIds === undefined
          ? {}
          : { inventoryLocationIds: req.body.inventoryLocationIds }),
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

/**
 * Return reasons: the groups and the library they pick from — what the
 * settings screen renders.
 *
 * Returned whole rather than paged: a merchant has a handful of groups and a
 * few dozen reasons, and editing them is much easier against one payload than
 * against a lazily-loaded tree.
 */
settingsRouter.get(
  "/reasons",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const [groups, library] = await Promise.all([
      reasonsService.listGroups(merchantId),
      reasonsService.listLibrary(merchantId),
    ]);
    res.json({
      groups: groups.map(reasonsService.serializeGroup),
      library: library.map(reasonsService.serializeReason),
      /** The only codes Shopify accepts; the editor offers exactly these. */
      shopifyCodes: [...SHOPIFY_RETURN_REASONS].sort(),
    });
  }),
);

const termList = z.array(z.string().trim().min(1).max(80)).max(50).optional();

const groupSchema = z.object({
  title: z.string().trim().min(1).max(80),
  productTypes: termList,
  productTags: termList,
  randomizeOrder: z.boolean().optional(),
  reasonIds: z.array(z.string().min(1).max(60)).max(200).optional(),
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
    res.status(201).json(reasonsService.serializeGroup(group));
  }),
);

settingsRouter.patch(
  "/reason-groups/:id",
  requireRole("OWNER", "ADMIN"),
  validate(groupSchema.partial()),
  asyncHandler(async (req, res) => {
    const group = await reasonsService.updateGroup(
      req.admin!.merchantId,
      req.params.id,
      req.body,
    );
    res.json(reasonsService.serializeGroup(group));
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

const subReasonSchema = z.object({
  id: z.string().min(1).max(60).nullable().optional(),
  label: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(40),
  requiresNote: z.boolean().optional(),
  requiresPhoto: z.boolean().optional(),
});

/** A reason and its whole set of sub-reasons, saved together. */
const reasonSchema = subReasonSchema.omit({ id: true }).extend({
  children: z.array(subReasonSchema).max(50).optional(),
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
    res.status(201).json(reasonsService.serializeReason(reason));
  }),
);

settingsRouter.put(
  "/reasons/:id",
  requireRole("OWNER", "ADMIN"),
  validate(reasonSchema),
  asyncHandler(async (req, res) => {
    const reason = await reasonsService.updateReason(
      req.admin!.merchantId,
      req.params.id,
      req.body,
    );
    res.json(reasonsService.serializeReason(reason));
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

  // Order lookup
  lookupCriteria: z
    .array(z.enum(["EMAIL", "ZIP", "PHONE"]))
    .min(1, "Customers need at least one way to verify their order")
    .transform(normalizeCriteria),

  // Content
  orderNumberLabel: z.string().trim().min(1).max(60),
  emailLabel: z.string().trim().min(1).max(60),
  zipLabel: z.string().trim().min(1).max(60),
  phoneLabel: z.string().trim().min(1).max(60),
  lookupHelpText: optionalText(300),
  startButtonLabel: z.string().trim().min(1).max(40),
  footerHeading: optionalText(60),
  footerText: optionalText(300),

  // AI exchange copy — null means the app's translation.
  aiSwitchLabel: optionalText(50),
  aiDetailsTitle: optionalText(50),
  aiSimilarTitle: optionalText(50),
  aiPriceCaption: optionalText(50),
  aiPrimaryLabel: optionalText(50),
  aiSecondaryLabel: optionalText(50),

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
    const merchantId = req.admin!.merchantId;

    /**
     * Phone verification is checked against Shopify as it's switched on, not
     * on every save: a criterion that can never match is worse than a refused
     * save, but a merchant changing a colour shouldn't be held up by Shopify
     * being slow. Whether it's *being* switched on is read from the stored
     * row, since the body is the whole form either way.
     */
    const criteria = req.body.lookupCriteria as
      | Array<"EMAIL" | "ZIP" | "PHONE">
      | undefined;
    if (criteria?.includes("PHONE")) {
      const current = await prisma.portalBranding.findUnique({
        where: { merchantId },
        select: { lookupCriteria: true },
      });
      if (!current?.lookupCriteria.includes("PHONE")) {
        const problem = await phoneAccessProblem(merchantId);
        if (problem) throw unprocessable(problem);
      }
    }

    const branding = await prisma.portalBranding.upsert({
      where: { merchantId },
      update: req.body,
      create: { merchantId, ...req.body },
    });
    res.json(branding);
  }),
);

// ---------------------------------------------------------------------------
// Customer notifications — which emails a store sends, and who they're from
// ---------------------------------------------------------------------------

/**
 * The store's Shopify locations, for the restock menus, with the store's
 * default alongside so a return page can label "Default" with a name.
 * An unconnected store gets an empty list rather than an error: the menus
 * then offer only the default, which is all they can honestly promise.
 */
settingsRouter.get(
  "/locations",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const [locations, merchant] = await Promise.all([
      listLocationsIfConnected(merchantId),
      prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { restockLocationId: true },
      }),
    ]);
    res.json({ locations, defaultLocationId: merchant.restockLocationId });
  }),
);

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
  /** Shown to the shopper as the exchange option. */
  name: z.string().trim().min(1).max(200),
  active: z.boolean().optional(),
  // Return item condition — "is any of".
  matchBy: z
    .enum(["PRODUCT_TAG", "PRODUCT_NAME", "PRODUCT_TYPE", "COLLECTION"])
    .optional(),
  matchValues: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  // Exchange item condition — "is any of".
  offerBy: z.enum(["PRODUCT_TAG", "PRODUCT_TYPE", "COLLECTION"]).optional(),
  offerValues: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  pricing: z.enum(["EVEN", "DIFFERENCE"]).optional(),
  inStockOnly: z.boolean().optional(),
  allowNote: z.boolean().optional(),
  showProductTitles: z.boolean().optional(),
  bonusType: z.enum(["PERCENT", "FIXED"]).optional(),
  /** Null clears the override, falling back to the store-wide bonus. */
  bonusValue: z.number().min(0).max(100000).nullable().optional(),
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

// ---------------------------------------------------------------------------
// Return policies — per-region overlays on the store policy
// ---------------------------------------------------------------------------

const REGION_LOCATION_GID = /^gid:\/\/shopify\/Location\/\d+$/;

const outcomeSchema = z
  .object({
    enabled: z.boolean(),
    /** Null is an unlimited window. */
    windowDays: z.number().int().min(1).max(3650).nullable(),
    /** Null charges nothing for this outcome. */
    fee: z
      .object({
        type: z.enum(["FLAT", "PERCENT", "PRODUCT_TAG"]),
        value: z.number().min(0).max(1_000_000),
      })
      .nullable(),
  })
  .refine((o) => !o.fee || o.fee.type !== "PERCENT" || o.fee.value <= 100, {
    message: "A percentage fee can't be more than 100%.",
  });

const PROVIDERS = ["SHIPROCKET", "DELHIVERY", "EASYPOST", "SHIPPO", "SHIPSTATION", "SENDCLOUD", "DHL_EXPRESS", "FEDEX", "AUSPOST", "DEUTSCHE_POST"] as const;

const regionalPolicySchema = z.object({
  name: z.string().trim().min(1).max(80),
  countries: z
    .array(
      z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{2}$/, "Countries must be two-letter ISO codes."),
    )
    .min(1, "Choose at least one country.")
    .max(250)
    .transform((codes) => [...new Set(codes)]),
  /** Null means the store's default destination. */
  destinationId: z.string().min(1).max(60).nullable(),
  /** Empty defers to the store-wide list. */
  inventoryLocationIds: z
    .array(z.string().regex(REGION_LOCATION_GID))
    .max(50)
    .transform((ids) => [...new Set(ids)]),
  allowInstantExchange: z.boolean(),
  allowAdvancedExchange: z.boolean(),
  /** Blank clears it, which keeps the app's own "Exchange shipping" line. */
  exchangeShippingMethod: z
    .string()
    .trim()
    .max(120)
    .nullable()
    .transform((v) => v || null),
  windowStartsFrom: z.enum(["ORDER_DATE", "FULFILLMENT", "DELIVERY"]),
  bypassReview: z.boolean(),
  /** Blank steps are dropped rather than refused: an empty row is a row the
      merchant hasn't filled in yet, not a mistake to send back. */
  instructions: z
    .array(z.string().trim().max(300))
    .max(20)
    .transform((steps) => steps.filter(Boolean)),
  generateLabels: z.boolean(),
  /** Null follows the store's default carrier; EXTERNAL asks the store's own connector. */
  labelProvider: z.enum([...PROVIDERS, "EXTERNAL"]).nullable(),
  packingSlips: z.boolean(),
  packingSlipTaxInclusive: z.boolean(),
  packingSlipBarcode: z.boolean(),
  packingSlipBarcodeSource: z.enum(["RETURN_ID", "ORDER_NUMBER"]),
  outcomes: z.object({
    REFUND: outcomeSchema,
    EXCHANGE: outcomeSchema,
    STORE_CREDIT: outcomeSchema,
    GIFT_CARD: outcomeSchema,
  }),
});

/**
 * Everything the policies page needs in one read: the policies, the store
 * policy they overlay (for the "Default" card and to prefill a new one), and
 * the locations a policy can send returns to.
 */
settingsRouter.get(
  "/regional-policies",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const [policies, base, merchant, locations, destinations] = await Promise.all([
      regionalPolicies.listRegionalPolicies(merchantId),
      prisma.returnPolicy.findFirst({
        where: { merchantId, isDefault: true, active: true },
      }),
      prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { restockLocationId: true, currency: true, inventoryLocationIds: true },
      }),
      listLocationsIfConnected(merchantId),
      destinationsService.listDestinations(merchantId),
    ]);
    res.json({
      policies: policies.map(regionalPolicies.serializeRegionalPolicy),
      base: base ? serializePolicy(base) : null,
      locations,
      defaultLocationId: merchant.restockLocationId,
      /** The store-wide exchange inventory locations; empty means all. */
      inventoryLocationIds: merchant.inventoryLocationIds,
      destinations: destinations.map(destinationsService.serializeDestination),
      currency: merchant.currency,
    });
  }),
);

/**
 * Whether the store's token can read stock per location — the Locations
 * page asks before letting the merchant choose any. A Shopify call, so it
 * is its own request rather than part of the list above.
 */
settingsRouter.get(
  "/inventory-access",
  asyncHandler(async (req, res) => {
    res.json({ problem: await inventoryAccessProblem(req.admin!.merchantId) });
  }),
);

// ---------------------------------------------------------------------------
// Tags and notes — what a return writes onto the Shopify order
// ---------------------------------------------------------------------------

settingsRouter.get(
  "/order-notes",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const [rules, canWrite] = await Promise.all([listOrderNoteRules(merchantId), canWriteOrders(merchantId)]);
    res.json({ rules, placeholders: ORDER_NOTE_PLACEHOLDERS, canWrite });
  }),
);

const orderNoteRuleSchema = z.object({
  event: z.enum(["SUBMITTED", "APPROVED", "RECEIVED", "REFUNDED_CREDIT", "REFUNDED_ORIGINAL", "EXCHANGE_CREATED", "EXPIRED"]),
  target: z.enum(["ORIGINAL", "EXCHANGE"]),
  enabled: z.boolean().optional(),
  tags: z.array(z.string().trim().max(40)).max(10).optional(),
  note: z.string().max(2000).optional(),
});

settingsRouter.patch(
  "/order-notes",
  validate(z.object({ rules: z.array(orderNoteRuleSchema).min(1).max(20) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    for (const rule of req.body.rules as z.infer<typeof orderNoteRuleSchema>[]) {
      await setOrderNoteRule(merchantId, rule.event, rule.target, rule);
    }
    res.json({ rules: await listOrderNoteRules(merchantId) });
  }),
);

// ---------------------------------------------------------------------------
// Destinations — where returned goods are sent
// ---------------------------------------------------------------------------

const optionalLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);

const destinationSchema = z.object({
  name: z.string().trim().min(1).max(80),
  address1: z.string().trim().min(1).max(200),
  address2: optionalLine(200),
  city: z.string().trim().min(1).max(100),
  province: optionalLine(100),
  zip: optionalLine(20),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Choose a country."),
  phone: optionalLine(40),
  company: optionalLine(100),
  contactName: optionalLine(100),
  email: z
    .union([z.string().trim().email().max(200), z.literal(""), z.null(), z.undefined()])
    .transform((v) => (v ? v : null)),
  isDefault: z.boolean().optional(),
  /** The Shopify Location to restock at; null when the destination isn't one. */
  locationId: z.string().regex(REGION_LOCATION_GID).nullable().optional().transform((v) => v ?? null),
});

settingsRouter.get(
  "/destinations",
  asyncHandler(async (req, res) => {
    const destinations = await destinationsService.listDestinations(req.admin!.merchantId);
    res.json({ destinations: destinations.map(destinationsService.serializeDestination) });
  }),
);

settingsRouter.post(
  "/destinations",
  validate(destinationSchema),
  asyncHandler(async (req, res) => {
    const created = await destinationsService.createDestination(
      req.admin!.merchantId,
      req.body,
    );
    res.status(201).json(destinationsService.serializeDestination(created));
  }),
);

settingsRouter.patch(
  "/destinations/:id",
  validate(destinationSchema),
  asyncHandler(async (req, res) => {
    const updated = await destinationsService.updateDestination(
      req.admin!.merchantId,
      req.params.id,
      req.body,
    );
    res.json(destinationsService.serializeDestination(updated));
  }),
);

settingsRouter.delete(
  "/destinations/:id",
  asyncHandler(async (req, res) => {
    await destinationsService.deleteDestination(req.admin!.merchantId, req.params.id);
    res.status(204).end();
  }),
);

// ---------------------------------------------------------------------------
// Return routing rules — which ways of sending items back are offered
// ---------------------------------------------------------------------------

const blankToNull = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v || null);

const routingMethodSchema = z.object({
  enabled: z.boolean(),
  name: z.string().trim().min(1).max(200),
  description: blankToNull(200),
  costMode: z.enum(["HIDDEN", "FREE", "FIXED"]),
  costAmount: z.number().min(0).max(1_000_000).nullable().optional().transform((v) => v ?? null),
  instructions: blankToNull(2000),
  autoApprove: z.boolean(),
  /** A link to the retail locations; only the store method keeps it. */
  storeUrl: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((v) => v || null)
    .refine((v) => v === null || /^https?:\/\/\S+$/i.test(v), {
      message: "Enter a valid URL, starting with http:// or https://.",
    }),
  /** LABEL only — the rule's return shipping information; each null defers. */
  carrier: z.enum([...PROVIDERS, "EXTERNAL"]).nullable().optional().transform((v) => v ?? null),
  serviceName: blankToNull(120),
  destinationId: z.string().min(1).max(60).nullable().optional().transform((v) => v ?? null),
  packageSizeId: z.string().min(1).max(60).nullable().optional().transform((v) => v ?? null),
});

const list = (max: number, itemMax = 80) =>
  z
    .array(z.string().trim().min(1).max(itemMax))
    .max(max)
    .transform((values) => [...new Set(values)])
    .optional();

const routingConditionsSchema = z
  .object({
    policies: list(50, 60),
    countries: z
      .array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/))
      .max(250)
      .transform((values) => [...new Set(values)])
      .optional(),
    productTags: list(50),
    productTypes: list(50),
    reasonIds: list(200, 60),
    resolutions: z
      .array(z.enum(["REFUND", "EXCHANGE", "STORE_CREDIT", "GIFT_CARD"]))
      .max(4)
      .optional(),
    valueUnder: z.number().min(0).max(10_000_000).optional(),
    valueAtLeast: z.number().min(0).max(10_000_000).optional(),
  })
  .strict();

const routingRuleSchema = z.object({
  name: z.string().trim().min(1).max(200),
  conditions: routingConditionsSchema,
  methods: z.object({
    LABEL: routingMethodSchema,
    CARRIER: routingMethodSchema,
    STORE: routingMethodSchema,
    KEEP: routingMethodSchema,
  }),
});

/**
 * The rules, plus what the condition builder chooses from: the store's
 * regional policies and its return reasons.
 */
settingsRouter.get(
  "/routing-rules",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    const [rules, policies, reasons, merchant] = await Promise.all([
      routing.listRoutingRules(merchantId),
      prisma.regionalPolicy.findMany({
        where: { merchantId },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: { id: true, name: true },
      }),
      prisma.returnReason.findMany({
        where: { merchantId, active: true },
        orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
        select: { id: true, label: true },
      }),
      prisma.merchant.findUniqueOrThrow({
        where: { id: merchantId },
        select: { currency: true },
      }),
    ]);
    const [destinations, sizes, shipping] = await Promise.all([
      destinationsService.listDestinations(merchantId),
      packageSizes.listPackageSizes(merchantId),
      shippingView(merchantId),
    ]);
    const connected = {
      SHIPROCKET: shipping.shiprocket, DELHIVERY: shipping.delhivery, EASYPOST: shipping.easypost, SHIPPO: shipping.shippo,
      SHIPSTATION: shipping.shipstation, SENDCLOUD: shipping.sendcloud, DHL_EXPRESS: shipping.dhlExpress, FEDEX: shipping.fedex,
      AUSPOST: shipping.ausPost, DEUTSCHE_POST: shipping.deutschePost, EXTERNAL: shipping.external,
    };
    res.json({
      rules: rules.map(routing.serializeRule),
      policies,
      reasons,
      currency: merchant.currency,
      // For the label method's return shipping information.
      destinations: destinations.map(destinationsService.serializeDestination),
      packageSizes: sizes.map(packageSizes.serializePackageSize),
      carriers: (Object.keys(connected) as Array<keyof typeof connected>).filter((id) => Boolean(connected[id])),
      defaultCarrier: shipping.settings.provider,
    });
  }),
);

settingsRouter.post(
  "/routing-rules",
  validate(routingRuleSchema),
  asyncHandler(async (req, res) => {
    const created = await routing.createRoutingRule(req.admin!.merchantId, req.body);
    res.status(201).json(routing.serializeRule(created));
  }),
);

settingsRouter.patch(
  "/routing-rules/:id",
  validate(routingRuleSchema),
  asyncHandler(async (req, res) => {
    const updated = await routing.updateRoutingRule(
      req.admin!.merchantId,
      req.params.id,
      req.body,
    );
    res.json(routing.serializeRule(updated));
  }),
);

settingsRouter.delete(
  "/routing-rules/:id",
  asyncHandler(async (req, res) => {
    await routing.deleteRoutingRule(req.admin!.merchantId, req.params.id);
    res.status(204).end();
  }),
);

/** Priority is the whole list's order; the default stays last regardless. */
settingsRouter.post(
  "/routing-rules/reorder",
  validate(z.object({ ids: z.array(z.string().min(1)).max(100) })),
  asyncHandler(async (req, res) => {
    await routing.reorderRoutingRules(req.admin!.merchantId, req.body.ids);
    const rules = await routing.listRoutingRules(req.admin!.merchantId);
    res.json({ rules: rules.map(routing.serializeRule) });
  }),
);

settingsRouter.post(
  "/regional-policies",
  validate(regionalPolicySchema),
  asyncHandler(async (req, res) => {
    const created = await regionalPolicies.createRegionalPolicy(
      req.admin!.merchantId,
      req.body,
    );
    res.status(201).json(regionalPolicies.serializeRegionalPolicy(created));
  }),
);

settingsRouter.patch(
  "/regional-policies/:id",
  validate(regionalPolicySchema),
  asyncHandler(async (req, res) => {
    const updated = await regionalPolicies.updateRegionalPolicy(
      req.admin!.merchantId,
      req.params.id,
      req.body,
    );
    res.json(regionalPolicies.serializeRegionalPolicy(updated));
  }),
);

settingsRouter.delete(
  "/regional-policies/:id",
  asyncHandler(async (req, res) => {
    await regionalPolicies.deleteRegionalPolicy(
      req.admin!.merchantId,
      req.params.id,
    );
    res.status(204).end();
  }),
);

settingsRouter.post(
  "/regional-policies/reorder",
  validate(z.object({ ids: z.array(z.string().min(1)).max(100) })),
  asyncHandler(async (req, res) => {
    await regionalPolicies.reorderRegionalPolicies(
      req.admin!.merchantId,
      req.body.ids,
    );
    const policies = await regionalPolicies.listRegionalPolicies(
      req.admin!.merchantId,
    );
    res.json({ policies: policies.map(regionalPolicies.serializeRegionalPolicy) });
  }),
);

// ---------------------------------------------------------------------------
// Shipping — carriers and return labels
// ---------------------------------------------------------------------------

const cm = z.number().min(1).max(500);
const shippingSettingsSchema = z
  .object({
    provider: z.enum([...PROVIDERS, "EXTERNAL"]).nullable(),
    autoCreate: z.boolean(),
    packingSlips: z.boolean(),
    packingSlipTaxInclusive: z.boolean(),
    packingSlipBarcode: z.boolean(),
    packingSlipBarcodeSource: z.enum(["RETURN_ID", "ORDER_NUMBER"]),
    packingSlipMethods: z.array(z.enum(["LABEL", "CARRIER", "STORE", "KEEP"])).max(4).transform((v) => [...new Set(v)]),
    autoCancelDays: z.number().int().min(1).max(365).nullable(),
    labelReferences: z
      .array(
        z.object({
          type: z.enum(LABEL_REFERENCE_TYPES as [string, ...string[]]),
          text: z.string().trim().max(35).optional(),
        }),
      )
      .max(MAX_LABEL_REFERENCES),
    receiveOnDelivery: z.boolean(),
    destinationId: z.string().min(1).max(60).nullable(),
    shippingEmail: z
      .union([z.string().trim().email().max(200), z.literal(""), z.null()])
      .transform((v) => (v ? v : null)),
    lengthCm: cm,
    breadthCm: cm,
    heightCm: cm,
    weightKg: z.number().min(0.05).max(500),
  })
  .partial();

/** Whether the courier can deliver to a destination: it wants a phone and a postcode. */
const readiness = (d: { phone: string | null; zip: string | null }) => ({
  hasPhone: indianMobile(d.phone) !== null,
  hasZip: Boolean(d.zip),
});

/**
 * Everything the Shipping page shows: the shared settings, each carrier's
 * connection, and every return destination with whether a courier can
 * deliver to it — it wants a phone number and a postcode, and it's better
 * to say so here than at the first approval.
 */
const shippingView = async (merchantId: string) => {
  const [settings, sr, dl, ep, sp, ss, sc, dx, fx, ap, dp, ex, destinations, destination, sizes, labelRules] = await Promise.all([
    shippingSettings.getSettings(merchantId),
    shiprocket.getAccount(merchantId),
    delhivery.getAccount(merchantId),
    easypost.getAccount(merchantId),
    shippo.getAccount(merchantId),
    shipstation.getAccount(merchantId),
    sendcloud.getAccount(merchantId),
    dhlexpress.getAccount(merchantId),
    fedex.getAccount(merchantId),
    auspost.getAccount(merchantId),
    dhlparcelde.getAccount(merchantId),
    external.getAccount(merchantId),
    destinationsService.listDestinations(merchantId),
    shippingSettings.deliveryDestination(merchantId),
    packageSizes.listPackageSizes(merchantId),
    prisma.returnRoutingRule.count({ where: { merchantId, methods: { some: { kind: "LABEL", enabled: true } } } }),
  ]);
  return {
    settings: shippingSettings.serializeSettings(settings),
    shiprocket: sr ? shiprocket.serializeAccount(sr) : null,
    delhivery: dl ? delhivery.serializeAccount(dl) : null,
    easypost: ep ? easypost.serializeAccount(ep) : null,
    shippo: sp ? shippo.serializeAccount(sp) : null,
    shipstation: ss ? shipstation.serializeAccount(ss) : null,
    sendcloud: sc ? sendcloud.serializeAccount(sc) : null,
    dhlExpress: dx ? dhlexpress.serializeAccount(dx) : null,
    fedex: fx ? fedex.serializeAccount(fx) : null,
    ausPost: ap ? auspost.serializeAccount(ap) : null,
    deutschePost: dp ? dhlparcelde.serializeAccount(dp) : null,
    external: ex ? external.serializeAccount(ex) : null,
    packageSizes: sizes.map(packageSizes.serializePackageSize),
    /** How many routing rules offer "Ship with a return label" — AfterShip's last setup step. */
    labelRules,
    webhookUrl: shiprocket.webhookUrl(),
    destinations: destinations.map((d) => ({ ...destinationsService.serializeDestination(d), ...readiness(d) })),
    /** Where parcels go today: the chosen destination, else the default. */
    destination: destination ? { id: destination.id, name: destination.name, ...readiness(destination) } : null,
  };
};

settingsRouter.get(
  "/shipping",
  asyncHandler(async (req, res) => {
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

/** The shared settings. Choosing a carrier needs that carrier connected. */
settingsRouter.patch(
  "/shipping",
  validate(shippingSettingsSchema),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    if (req.body.provider === "SHIPROCKET" && !(await shiprocket.getAccount(merchantId))) {
      throw unprocessable("Connect Shiprocket before choosing it.");
    }
    if (req.body.provider === "DELHIVERY" && !(await delhivery.getAccount(merchantId))) {
      throw unprocessable("Connect Delhivery before choosing it.");
    }
    if (req.body.provider === "EASYPOST" && !(await easypost.getAccount(merchantId))) {
      throw unprocessable("Connect EasyPost before choosing it.");
    }
    if (req.body.provider === "SHIPPO" && !(await shippo.getAccount(merchantId))) {
      throw unprocessable("Connect Shippo before choosing it.");
    }
    if (req.body.provider === "SHIPSTATION" && !(await shipstation.getAccount(merchantId))) {
      throw unprocessable("Connect ShipStation before choosing it.");
    }
    if (req.body.provider === "SENDCLOUD" && !(await sendcloud.getAccount(merchantId))) {
      throw unprocessable("Connect Sendcloud before choosing it.");
    }
    if (req.body.provider === "DHL_EXPRESS" && !(await dhlexpress.getAccount(merchantId))) {
      throw unprocessable("Connect DHL Express before choosing it.");
    }
    if (req.body.provider === "FEDEX" && !(await fedex.getAccount(merchantId))) {
      throw unprocessable("Connect FedEx before choosing it.");
    }
    if (req.body.provider === "AUSPOST" && !(await auspost.getAccount(merchantId))) {
      throw unprocessable("Connect Australia Post before choosing it.");
    }
    if (req.body.provider === "DEUTSCHE_POST" && !(await dhlparcelde.getAccount(merchantId))) {
      throw unprocessable("Connect DHL Paket before choosing it.");
    }
    if (req.body.provider === "EXTERNAL" && !(await external.getAccount(merchantId))) {
      throw unprocessable("Set up the external connector before choosing it.");
    }
    await shippingSettings.updateSettings(merchantId, req.body);
    res.json(await shippingView(merchantId));
  }),
);

// --- Package sizes ---

const packageSizeSchema = z.object({
  name: z.string().trim().min(1).max(80),
  length: z.number().min(0.1).max(10_000),
  width: z.number().min(0.1).max(10_000),
  height: z.number().min(0.1).max(10_000),
  unit: z.enum(["CM", "IN"]),
  weight: z.number().min(0).max(10_000),
  massUnit: z.enum(["KG", "LB"]),
  isDefault: z.boolean().optional(),
});

settingsRouter.post(
  "/package-sizes",
  validate(packageSizeSchema),
  asyncHandler(async (req, res) => {
    const created = await packageSizes.createPackageSize(req.admin!.merchantId, req.body);
    res.status(201).json(packageSizes.serializePackageSize(created));
  }),
);

settingsRouter.patch(
  "/package-sizes/:id",
  validate(packageSizeSchema),
  asyncHandler(async (req, res) => {
    const updated = await packageSizes.updatePackageSize(req.admin!.merchantId, req.params.id, req.body);
    res.json(packageSizes.serializePackageSize(updated));
  }),
);

settingsRouter.delete(
  "/package-sizes/:id",
  asyncHandler(async (req, res) => {
    await packageSizes.deletePackageSize(req.admin!.merchantId, req.params.id);
    res.status(204).end();
  }),
);

// --- Shiprocket ---

settingsRouter.post(
  "/shiprocket/connect",
  validate(z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shiprocket.connectAccount(merchantId, req.body.email, req.body.password);
    // The first carrier connected becomes the one that books.
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "SHIPROCKET" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/shiprocket",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shiprocket.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "SHIPROCKET") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/shiprocket",
  validate(z.object({ testMode: z.boolean(), qcEnabled: z.boolean() }).partial()),
  asyncHandler(async (req, res) => {
    await shiprocket.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/shiprocket/webhook-secret",
  asyncHandler(async (req, res) => {
    await shiprocket.rotateWebhookSecret(req.admin!.merchantId);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/shiprocket/test",
  asyncHandler(async (req, res) => {
    res.json(await shiprocket.testConnection(req.admin!.merchantId));
  }),
);

// --- Delhivery ---

settingsRouter.post(
  "/delhivery/connect",
  validate(
    z.object({
      token: z.string().trim().min(8).max(200),
      staging: z.boolean().default(true),
      warehouseName: z.string().trim().min(1).max(120),
    }),
  ),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await delhivery.connectAccount(merchantId, req.body.token, req.body.staging, req.body.warehouseName);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "DELHIVERY" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/delhivery",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await delhivery.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "DELHIVERY") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/delhivery",
  validate(z.object({ staging: z.boolean(), warehouseName: z.string().trim().min(1).max(120) }).partial()),
  asyncHandler(async (req, res) => {
    await delhivery.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/delhivery/test",
  asyncHandler(async (req, res) => {
    res.json(await delhivery.testConnection(req.admin!.merchantId));
  }),
);

// --- EasyPost ---

settingsRouter.post(
  "/easypost/connect",
  validate(z.object({ apiKey: z.string().trim().min(8).max(200) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await easypost.connectAccount(merchantId, req.body.apiKey);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "EASYPOST" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/easypost",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await easypost.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "EASYPOST") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.post(
  "/easypost/webhook-secret",
  asyncHandler(async (req, res) => {
    await easypost.rotateWebhookSecret(req.admin!.merchantId);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/easypost/test",
  asyncHandler(async (req, res) => {
    res.json(await easypost.testConnection(req.admin!.merchantId));
  }),
);

// --- Shippo ---

settingsRouter.post(
  "/shippo/connect",
  validate(z.object({ token: z.string().trim().min(8).max(200) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shippo.connectAccount(merchantId, req.body.token);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "SHIPPO" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/shippo",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shippo.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "SHIPPO") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.post(
  "/shippo/webhook-secret",
  asyncHandler(async (req, res) => {
    await shippo.rotateWebhookSecret(req.admin!.merchantId);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/shippo/test",
  asyncHandler(async (req, res) => {
    res.json(await shippo.testConnection(req.admin!.merchantId));
  }),
);

// --- ShipStation ---

settingsRouter.post(
  "/shipstation/connect",
  validate(z.object({ apiKey: z.string().trim().min(8).max(200), apiSecret: z.string().trim().min(8).max(200), currency: z.string().trim().length(3).toUpperCase().default("USD") })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shipstation.connectAccount(merchantId, req.body.apiKey, req.body.apiSecret, req.body.currency);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "SHIPSTATION" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/shipstation",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await shipstation.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "SHIPSTATION") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/shipstation",
  validate(z.object({ testMode: z.boolean().optional(), currency: z.string().trim().length(3).toUpperCase().optional() })),
  asyncHandler(async (req, res) => {
    await shipstation.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/shipstation/test",
  asyncHandler(async (req, res) => {
    res.json(await shipstation.testConnection(req.admin!.merchantId));
  }),
);

// --- Sendcloud ---

settingsRouter.post(
  "/sendcloud/connect",
  validate(z.object({ publicKey: z.string().trim().min(8).max(200), secretKey: z.string().trim().min(8).max(200), testMode: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await sendcloud.connectAccount(merchantId, req.body.publicKey, req.body.secretKey, req.body.testMode);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "SENDCLOUD" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/sendcloud",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await sendcloud.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "SENDCLOUD") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/sendcloud",
  validate(z.object({ testMode: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    await sendcloud.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/sendcloud/test",
  asyncHandler(async (req, res) => {
    res.json(await sendcloud.testConnection(req.admin!.merchantId));
  }),
);

// --- DHL_EXPRESS ---

settingsRouter.post(
  "/dhl-express/connect",
  validate(z.object({ apiKey: z.string().trim().min(4).max(200), apiSecret: z.string().trim().min(4).max(200), accountNumber: z.string().trim().min(4).max(40), testMode: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await dhlexpress.connectAccount(merchantId, req.body.apiKey, req.body.apiSecret, req.body.accountNumber, req.body.testMode);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "DHL_EXPRESS" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/dhl-express",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await dhlexpress.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "DHL_EXPRESS") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/dhl-express",
  validate(z.object({ testMode: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    await dhlexpress.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/dhl-express/test",
  asyncHandler(async (req, res) => {
    res.json(await dhlexpress.testConnection(req.admin!.merchantId));
  }),
);

// --- EXTERNAL connector ---

settingsRouter.post(
  "/external/connect",
  validate(z.object({ url: z.string().trim().min(8).max(500), secret: z.string().trim().max(200).optional().nullable() })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await external.connectAccount(merchantId, req.body.url, req.body.secret);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "EXTERNAL" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/external",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await external.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "EXTERNAL") await shippingSettings.updateSettings(merchantId, { provider: null });
    // Policies that named it follow the store's default again.
    await prisma.regionalPolicy.updateMany({ where: { merchantId, labelProvider: "EXTERNAL" }, data: { labelProvider: null } });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.post(
  "/external/test",
  asyncHandler(async (req, res) => {
    res.json(await external.testConnection(req.admin!.merchantId));
  }),
);

// --- FEDEX ---

settingsRouter.post(
  "/fedex/connect",
  validate(z.object({ clientId: z.string().trim().min(4).max(200), clientSecret: z.string().trim().min(4).max(200), accountNumber: z.string().trim().min(4).max(40), testMode: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await fedex.connectAccount(merchantId, req.body.clientId, req.body.clientSecret, req.body.accountNumber, req.body.testMode);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "FEDEX" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/fedex",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await fedex.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "FEDEX") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/fedex",
  validate(z.object({ testMode: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    await fedex.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/fedex/test",
  asyncHandler(async (req, res) => {
    res.json(await fedex.testConnection(req.admin!.merchantId));
  }),
);

// --- AUSPOST ---

settingsRouter.post(
  "/auspost/connect",
  validate(z.object({ apiKey: z.string().trim().min(4).max(200), password: z.string().trim().min(4).max(200), accountNumber: z.string().trim().min(4).max(40), testMode: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await auspost.connectAccount(merchantId, req.body.apiKey, req.body.password, req.body.accountNumber, req.body.testMode);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "AUSPOST" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/auspost",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await auspost.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "AUSPOST") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/auspost",
  validate(z.object({ testMode: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    await auspost.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/auspost/test",
  asyncHandler(async (req, res) => {
    res.json(await auspost.testConnection(req.admin!.merchantId));
  }),
);

// --- DEUTSCHE_POST ---

settingsRouter.post(
  "/deutsche-post/connect",
  validate(z.object({ apiKey: z.string().trim().min(4).max(200), username: z.string().trim().min(2).max(200), password: z.string().trim().min(4).max(200), billingNumber: z.string().trim().min(14).max(14), testMode: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await dhlparcelde.connectAccount(merchantId, req.body.apiKey, req.body.username, req.body.password, req.body.billingNumber, req.body.testMode);
    const settings = await shippingSettings.getSettings(merchantId);
    if (!settings.provider) await shippingSettings.updateSettings(merchantId, { provider: "DEUTSCHE_POST" });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.delete(
  "/deutsche-post",
  asyncHandler(async (req, res) => {
    const merchantId = req.admin!.merchantId;
    await dhlparcelde.disconnectAccount(merchantId);
    const settings = await shippingSettings.getSettings(merchantId);
    if (settings.provider === "DEUTSCHE_POST") await shippingSettings.updateSettings(merchantId, { provider: null });
    res.json(await shippingView(merchantId));
  }),
);

settingsRouter.patch(
  "/deutsche-post",
  validate(z.object({ testMode: z.boolean().optional() })),
  asyncHandler(async (req, res) => {
    await dhlparcelde.updateAccount(req.admin!.merchantId, req.body);
    res.json(await shippingView(req.admin!.merchantId));
  }),
);

settingsRouter.post(
  "/deutsche-post/test",
  asyncHandler(async (req, res) => {
    res.json(await dhlparcelde.testConnection(req.admin!.merchantId));
  }),
);
