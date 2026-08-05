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

export const selectionSchema = z.object({
  orderLineItemId: z.string().min(1),
  quantity: z.number().int().positive().max(999),
  reasonCode: z.string().min(1, "Choose a reason"),
  reasonNote: z.string().trim().max(500).optional(),
  photoUrls: z.array(z.string().url()).max(5).default([]),
});

export const quoteSchema = z.object({
  resolution: z.enum([
    "REFUND",
    "STORE_CREDIT",
    "EXCHANGE",
    "INSTANT_EXCHANGE",
  ]),
  items: z.array(selectionSchema).min(1, "Select at least one item"),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const submitSchema = quoteSchema.extend({
  customerNote: z.string().trim().max(1000).optional(),
  exchangeItems: z
    .array(
      z.object({
        variantId: z.string().min(1),
        productId: z.string().optional(),
        sku: z.string().optional(),
        title: z.string().min(1),
        variantTitle: z.string().optional(),
        imageUrl: z.string().url().optional(),
        quantity: z.number().int().positive().max(99),
        unitPrice: z.number().nonnegative(),
      }),
    )
    .max(20)
    .default([]),
});
export type SubmitInput = z.infer<typeof submitSchema>;
