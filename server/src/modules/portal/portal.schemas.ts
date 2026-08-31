import { z } from "zod";

export const lookupSchema = z.object({
  merchantSlug: z.string().min(1),
  // Shoppers type "#1001" or "1001"; normalize before it reaches the service.
  orderNumber: z
    .string()
    .trim()
    .min(1, "Enter your order number")
    .max(50)
    .transform((v) => v.replace(/^#/, "")),
  email: z.string().trim().toLowerCase().email("Enter a valid email address"),
});
export type LookupInput = z.infer<typeof lookupSchema>;

export const resolutionEnum = z.enum([
  "REFUND",
  "STORE_CREDIT",
  "GIFT_CARD",
  "EXCHANGE",
  "INSTANT_EXCHANGE",
]);

/** The replacement chosen for one exchanged line. */
export const exchangeChoiceSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive().max(99).default(1),
});

/**
 * One returned item, with its own resolution.
 *
 * Prices are deliberately absent: the client says *which* variant it wants,
 * never what it costs. Every figure is resolved server-side from Shopify, so a
 * tampered request can't manufacture a cheaper exchange or a larger payout.
 */
/**
 * One returned article — a single physical unit.
 *
 * There is deliberately no `quantity`: three of the same product are three
 * separate selections, because each one has its own condition. Grouping them
 * forced a single reason and a single resolution onto units that genuinely
 * differ — one damaged, one the wrong size, one simply unwanted.
 */
export const selectionSchema = z.object({
  orderLineItemId: z.string().min(1),
  /** Reason id, not code — codes repeat across differently-worded reasons. */
  reasonId: z.string().min(1, "Choose a reason"),
  reasonNote: z.string().trim().max(500).optional(),
  photoUrls: z.array(z.string().url()).max(5).default([]),
  resolution: resolutionEnum,
  /**
   * Required when the resolution is an exchange, ignored otherwise — but see
   * the object-level check below: a "shop now" basket replaces the per-line
   * choice, so the rule is enforced there rather than here, where a line can't
   * see whether a basket exists.
   */
  exchange: exchangeChoiceSchema.optional(),
});

/** An exchange line has to say what it's swapping for, unless a basket does. */
const namesItsReplacement = (v: {
  items: Array<{ resolution: string; exchange?: unknown }>;
  shopItems?: unknown[];
}) =>
  Boolean(v.shopItems?.length) ||
  v.items.every(
    (i) =>
      !["EXCHANGE", "INSTANT_EXCHANGE"].includes(i.resolution) ||
      i.exchange !== undefined,
  );

/**
 * A "shop now" basket: what the shopper is spending their return value on.
 *
 * Separate from the per-line `exchange` choice because it belongs to the return
 * as a whole — several returned items paying for one basket is not expressible
 * as a set of one-for-one swaps. Prices are absent here for the same reason
 * they are absent above: the client names variants, the server prices them.
 */
export const shopItemSchema = z.object({
  variantId: z.string().min(1),
  quantity: z.number().int().positive().max(99).default(1),
});

/** The two request bodies share a shape; spelled out rather than generated,
   because a generic wrapper loses Zod's inference on the cross-field checks. */
const basket = {
  items: z.array(selectionSchema).min(1, "Select at least one item"),
  shopItems: z.array(shopItemSchema).max(50).optional(),
};

/** Returning something towards a basket means all of it goes to the basket. */
const allLinesFeedTheBasket = (v: {
  items: Array<{ resolution: string }>;
  shopItems?: unknown[];
}) =>
  !v.shopItems?.length ||
  v.items.every((i) => ["EXCHANGE", "INSTANT_EXCHANGE"].includes(i.resolution));

export const quoteSchema = z
  .object(basket)
  .refine(namesItsReplacement, {
    message: "Choose what to exchange this item for",
    path: ["items"],
  })
  .refine(allLinesFeedTheBasket, {
    message: "Everything you return has to go towards the basket.",
    path: ["shopItems"],
  });
export type QuoteInput = z.infer<typeof quoteSchema>;

export const submitSchema = z
  .object({
    ...basket,
    customerNote: z.string().trim().max(1000).optional(),
    /**
     * How to pay a trade-down's leftover. Ignored unless the exchange actually
     * leaves the shopper owed something, and defaulted server-side so an older
     * client that doesn't send it keeps behaving as before.
     */
    exchangeSurplusMethod: z
      .enum(["REFUND", "STORE_CREDIT", "GIFT_CARD"])
      .optional(),
  })
  .refine(namesItsReplacement, {
    message: "Choose what to exchange this item for",
    path: ["items"],
  })
  .refine(allLinesFeedTheBasket, {
    message: "Everything you return has to go towards the basket.",
    path: ["shopItems"],
  });
export type SubmitInput = z.infer<typeof submitSchema>;

/** Reference + email is how the status page authenticates, without a session. */
export const referenceAuthSchema = z.object({
  slug: z.string().min(1),
  email: z.string().trim().toLowerCase().email(),
});

const score = z.coerce.number().int().min(1).max(5).optional();

/** The confirmation-page survey. Every field is optional but one is required. */
export const feedbackSchema = z
  .object({
    easeScore: score,
    repeatScore: score,
    comment: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) =>
      v.easeScore !== undefined ||
      v.repeatScore !== undefined ||
      Boolean(v.comment),
    { message: "Choose a rating or leave a comment before submitting." },
  );
export type FeedbackInput = z.infer<typeof feedbackSchema>;
