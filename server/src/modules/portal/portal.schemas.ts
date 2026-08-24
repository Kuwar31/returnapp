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
export const selectionSchema = z
  .object({
    orderLineItemId: z.string().min(1),
    /** Reason id, not code — codes repeat across differently-worded reasons. */
    reasonId: z.string().min(1, "Choose a reason"),
    reasonNote: z.string().trim().max(500).optional(),
    photoUrls: z.array(z.string().url()).max(5).default([]),
    resolution: resolutionEnum,
    /** Required when the resolution is an exchange, ignored otherwise. */
    exchange: exchangeChoiceSchema.optional(),
  })
  .refine(
    (item) =>
      !["EXCHANGE", "INSTANT_EXCHANGE"].includes(item.resolution) ||
      item.exchange !== undefined,
    { message: "Choose what to exchange this item for", path: ["exchange"] },
  );

export const quoteSchema = z.object({
  items: z.array(selectionSchema).min(1, "Select at least one item"),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const submitSchema = z.object({
  items: z.array(selectionSchema).min(1, "Select at least one item"),
  customerNote: z.string().trim().max(1000).optional(),
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
