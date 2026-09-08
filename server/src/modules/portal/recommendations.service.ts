import { notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  browseProducts,
  type ExchangeProduct,
} from "../shopify/catalogue.service.js";
import {
  offerQuery,
  rulesForLine,
} from "../settings/exchange-rules.service.js";
import { catalogueConverter, getOrderEligibility } from "./portal.service.js";

/**
 * "AI exchange": one recommended replacement, offered the moment a shopper
 * has said why an item is coming back — before the ordinary choice between
 * exchanging and returning.
 *
 * The ranking is deliberate rather than learned. Nothing here models other
 * shoppers; there is no data for that, and inventing it would be worse than
 * saying nothing. What it uses is what the store actually knows: the reason
 * given ("too small" means the same item in another size), the exchange
 * groups the merchant wrote for this item, then the catalogue's own type and
 * tags, and finally how close in price a candidate is to what came back.
 * The order is the recommendation; the shopper can step through the rest.
 */

export interface Recommendation extends ExchangeProduct {
  /** The exchange group it was drawn from, when one applies. */
  ruleId: string | null;
  /** How the group settles the price gap; DIFFERENCE when no group. */
  pricing: "EVEN" | "DIFFERENCE";
  /** The returned item itself, in its other options. */
  sameProduct: boolean;
}

/** Reasons that mean "the item was right, the option wasn't". */
const FIT = /small|large|big|tight|loose|fit|size|long|short/i;

const phrase = (value: string) => `"${value.replace(/["\\]/g, "").trim()}"`;

/** How many candidates the shopper can page through. */
const LIMIT = 6;

export const recommendExchanges = async (
  merchantId: string,
  orderId: string,
  orderLineItemId: string,
  reasonId?: string,
): Promise<{ candidates: Recommendation[]; currentVariantId: string | null } | null> => {
  const merchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: merchantId },
    select: { aiExchangeEnabled: true },
  });
  if (!merchant.aiExchangeEnabled) return null;

  const line = await prisma.orderLineItem.findFirst({
    where: { id: orderLineItemId, order: { id: orderId, merchantId } },
  });
  if (!line) throw notFound("That item isn't part of this order.");

  // Only for an item the policy lets be exchanged at all.
  const { eligibility } = await getOrderEligibility(merchantId, orderId);
  const evaluated = eligibility.items.find((i) => i.id === line.id);
  if (
    !evaluated?.eligible ||
    !evaluated.allowedResolutions.some(
      (r) => r === "EXCHANGE" || r === "INSTANT_EXCHANGE",
    )
  ) {
    return null;
  }

  const reason = reasonId
    ? await prisma.returnReason.findFirst({
        where: { id: reasonId },
        select: { code: true, label: true },
      })
    : null;
  const fit = reason ? FIT.test(`${reason.code} ${reason.label}`) : false;

  const rules = await rulesForLine(merchantId, line);

  interface Pool {
    products: ExchangeProduct[];
    ruleId: string | null;
    pricing: "EVEN" | "DIFFERENCE";
    /** Where the pool ranks; the reason and the merchant's groups outrank inference. */
    weight: number;
  }
  const pools: Pool[] = [];
  const gather = async (
    opts: { filter?: string; includeSoldOut?: boolean },
    ruleId: string | null,
    pricing: "EVEN" | "DIFFERENCE",
    weight: number,
  ) => {
    try {
      const { products } = await browseProducts(merchantId, { ...opts, limit: 12 });
      pools.push({ products, ruleId, pricing, weight });
    } catch (error) {
      logger.warn({ merchantId, opts, error }, "Could not gather exchange recommendations");
    }
  };

  /**
   * The item itself, in its other options: the strongest answer when the
   * reason was fit, and a fallback candidate otherwise. Shopify's product
   * search takes the numeric id, not the GID.
   */
  const numericId = line.productId?.split("/").pop();
  if (numericId) await gather({ filter: `id:${numericId}` }, null, "DIFFERENCE", fit ? 100 : 0);

  // The merchant's own pairings, in their order.
  for (const [i, rule] of rules.entries()) {
    await gather({ filter: offerQuery(rule) }, rule.id, rule.pricing, 40 - i);
  }

  // Without groups, things like it: same type first, then shared tags.
  if (rules.length === 0) {
    if (line.productType) {
      await gather({ filter: `product_type:${phrase(line.productType)}` }, null, "DIFFERENCE", 20);
    }
    const tags = line.productTags.filter(Boolean).slice(0, 5);
    if (tags.length > 0) {
      const clause = tags.map((t) => `tag:${phrase(t)}`).join(" OR ");
      await gather({ filter: tags.length === 1 ? clause : `(${clause})` }, null, "DIFFERENCE", 10);
    }
  }

  // A store with nothing alike still has a catalogue.
  if (pools.every((p) => p.products.length === 0)) {
    await gather({}, null, "DIFFERENCE", 0);
  }

  const unit = Number(line.unitPrice);
  const best = new Map<
    string,
    { product: ExchangeProduct; score: number; ruleId: string | null; pricing: "EVEN" | "DIFFERENCE"; sameProduct: boolean }
  >();
  for (const pool of pools) {
    for (const product of pool.products) {
      const sameProduct = product.id === line.productId;
      // Their own item is only worth offering in an option they don't have.
      const available = product.variants.filter(
        (v) => v.available && !(sameProduct && v.id === line.variantId),
      );
      if (available.length === 0) continue;
      let score = pool.weight;
      // Close in price reads as a like-for-like swap; far apart reads as a sale.
      const gap = Math.abs(product.minPrice - unit) / Math.max(unit, 1);
      score -= Math.min(10, gap * 10);
      const prev = best.get(product.id);
      if (!prev || prev.score < score) {
        best.set(product.id, { product, score, ruleId: pool.ruleId, pricing: pool.pricing, sameProduct });
      }
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, LIMIT);
  if (ranked.length === 0) return null;

  // Priced like everything else the shopper sees, at this order's own rate.
  const fx = await catalogueConverter(merchantId, orderId);
  return {
    currentVariantId: line.variantId,
    candidates: ranked.map(({ product, ruleId, pricing, sameProduct }) => ({
      ...product,
      minPrice: fx.price(product.minPrice),
      maxPrice: fx.price(product.maxPrice),
      currency: fx.currency,
      variants: product.variants.map((v) => ({ ...v, price: fx.price(v.price) })),
      ruleId,
      pricing,
      sameProduct,
    })),
  };
};
