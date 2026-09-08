import { notFound } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { prisma } from "../../lib/prisma.js";
import {
  browseProducts,
  type ExchangeProduct,
} from "../shopify/catalogue.service.js";
import { offerQuery } from "../settings/exchange-rules.service.js";
import { inventoryScopeFor } from "../policy/regional.service.js";
import {
  catalogueConverter,
  getOrderEligibility,
  rulesForOrderLine,
} from "./portal.service.js";
import {
  carrySizeAcross,
  readIntent,
  recommendVariant,
  type Intent,
  type VariantPick,
} from "./variant-intelligence.js";

/**
 * "AI exchange": one recommended replacement, offered the moment a shopper
 * has said why an item is coming back — before the ordinary choice between
 * exchanging and returning.
 *
 * Three inputs, as Loop and AfterShip describe theirs: the reason and the
 * comment beside it, read for what the shopper wants (see
 * variant-intelligence); what other shoppers chose after returning the same
 * variant for the same reason; and the variants actually in stock. The
 * merchant's exchange groups add products the item is allowed to become.
 *
 * A recommendation is only made when there is a real signal — a variant
 * that answers the reason, or a group the merchant wrote for this item.
 * Products that are merely alike are shown beneath as similar choices, never
 * as the recommendation on their own: an irrelevant suggestion is worse
 * than none, and the flow proceeds without one.
 */

export interface Recommendation extends ExchangeProduct {
  /** The exchange group it was drawn from, when one applies. */
  ruleId: string | null;
  /** How the group settles the price gap; DIFFERENCE when no group. */
  pricing: "EVEN" | "DIFFERENCE";
  /** The returned item itself, in its other options. */
  sameProduct: boolean;
  /** The option to open on — the one that answers the reason, when one does. */
  recommendedVariantId: string | null;
  /** Why that option, for the line under the card. Null when it's a guess. */
  rationale: VariantPick["rationale"] | null;
}

const phrase = (value: string) => `"${value.replace(/["\\]/g, "").trim()}"`;

/** How many candidates the shopper can page through. */
const LIMIT = 6;

/** A pool ranks as a recommendation only from here up; below is "similar". */
const STRONG = 40;

/**
 * What other shoppers ended up with after returning this very variant for
 * the same reason: the variant they exchanged into, and how many did.
 */
const exchangeHistory = async (
  merchantId: string,
  line: { productId: string | null; variantId: string | null },
  reasonCode: string | null,
): Promise<Map<string, number>> => {
  if (!line.productId || !line.variantId || !reasonCode) return new Map();
  const rows = await prisma.exchangeItem.groupBy({
    by: ["variantId"],
    where: {
      variantId: { not: null },
      returnRequest: { merchantId },
      returnLineItem: {
        orderLineItem: { productId: line.productId, variantId: line.variantId },
        reason: { code: reasonCode },
      },
    },
    _count: { _all: true },
  });
  return new Map(
    rows.flatMap((r) => (r.variantId ? [[r.variantId, r._count._all] as [string, number]] : [])),
  );
};

export const recommendExchanges = async (
  merchantId: string,
  orderId: string,
  orderLineItemId: string,
  reasonId?: string,
  comment?: string,
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
  const intent: Intent = readIntent(
    `${reason?.label ?? ""} ${reason?.code ?? ""}`,
    comment ?? "",
  );
  const history = await exchangeHistory(merchantId, line, reason?.code ?? null);

  // The groups, and the locations whose stock counts, both under the order's policy.
  const [rules, scope] = await Promise.all([
    rulesForOrderLine(merchantId, orderId, line),
    inventoryScopeFor(merchantId, orderId),
  ]);

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
      const { products } = await browseProducts(merchantId, {
        ...opts,
        limit: 12,
        locationIds: scope,
      });
      pools.push({ products, ruleId, pricing, weight });
    } catch (error) {
      logger.warn({ merchantId, opts, error }, "Could not gather exchange recommendations");
    }
  };

  /**
   * The item itself, in its other options. Whether it leads is decided
   * below, by whether one of those options answers the reason — not by the
   * reason's wording alone. Shopify's product search takes the numeric id.
   */
  const numericId = line.productId?.split("/").pop();
  if (numericId) await gather({ filter: `id:${numericId}` }, null, "DIFFERENCE", 0);

  // The merchant's own pairings, in their order.
  for (const [i, rule] of rules.entries()) {
    await gather({ filter: offerQuery(rule) }, rule.id, rule.pricing, STRONG - i);
  }

  // Things like it, for the similar-choices row: same type, then shared tags.
  if (line.productType) {
    await gather({ filter: `product_type:${phrase(line.productType)}` }, null, "DIFFERENCE", 20);
  }
  const tags = line.productTags.filter(Boolean).slice(0, 5);
  if (tags.length > 0) {
    const clause = tags.map((t) => `tag:${phrase(t)}`).join(" OR ");
    await gather({ filter: tags.length === 1 ? clause : `(${clause})` }, null, "DIFFERENCE", 10);
  }

  const unit = Number(line.unitPrice);
  const currentOptions =
    pools
      .flatMap((p) => p.products)
      .find((p) => p.id === line.productId)
      ?.variants.find((v) => v.id === line.variantId)?.options ?? [];

  const best = new Map<
    string,
    {
      product: ExchangeProduct;
      score: number;
      ruleId: string | null;
      pricing: "EVEN" | "DIFFERENCE";
      sameProduct: boolean;
      pick: VariantPick | null;
      preselect: string | null;
    }
  >();
  for (const pool of pools) {
    for (const product of pool.products) {
      const sameProduct = product.id === line.productId;
      // Their own item is only worth offering in an option they don't have —
      // unless the unit was faulty, when the same option again is the point.
      const available = product.variants.filter(
        (v) =>
          v.available &&
          !(sameProduct && !intent.replacement && v.id === line.variantId),
      );
      if (available.length === 0) continue;

      let score = pool.weight;
      let pick: VariantPick | null = null;
      let preselect: string | null = null;
      if (sameProduct) {
        /**
         * The reason, answered: a variant that fixes what the shopper said
         * makes the item itself the recommendation, above any group. No
         * answer means the item sits with the similar choices, at best.
         */
        pick = recommendVariant(product.variants, line.variantId, intent, history);
        if (pick) {
          score = 100;
          preselect = pick.variantId;
        }
      } else {
        // Another product: open it on the shopper's own size, stepped if asked.
        preselect = carrySizeAcross(product.variants, currentOptions, intent);
      }

      // Close in price reads as a like-for-like swap; far apart reads as a sale.
      const gap = Math.abs(product.minPrice - unit) / Math.max(unit, 1);
      score -= Math.min(10, gap * 10);

      const prev = best.get(product.id);
      if (!prev || prev.score < score) {
        best.set(product.id, { product, score, ruleId: pool.ruleId, pricing: pool.pricing, sameProduct, pick, preselect });
      }
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score).slice(0, LIMIT);
  // No variant answers the reason and no group covers the item: say nothing.
  if (ranked.length === 0 || ranked[0].score < STRONG - LIMIT) return null;

  // Priced like everything else the shopper sees, at this order's own rate.
  const fx = await catalogueConverter(merchantId, orderId);
  return {
    currentVariantId: line.variantId,
    candidates: ranked.map(({ product, ruleId, pricing, sameProduct, pick, preselect }) => ({
      ...product,
      minPrice: fx.price(product.minPrice),
      maxPrice: fx.price(product.maxPrice),
      currency: fx.currency,
      variants: product.variants.map((v) => ({ ...v, price: fx.price(v.price) })),
      ruleId,
      pricing,
      sameProduct,
      recommendedVariantId: preselect,
      rationale: pick?.rationale ?? null,
    })),
  };
};
