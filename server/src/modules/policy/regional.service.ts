import type {
  Order,
  RegionalPolicy,
  RegionalPolicyOutcome,
  ReturnPolicy,
} from "@prisma/client";
import { prisma } from "../../lib/prisma.js";
import {
  applyRegionalPolicy,
  type EffectivePolicy,
  type OutcomeKey,
  type OutcomeMap,
  type RegionalTerms,
} from "./effective.js";

/** The outcomes a regional policy holds a row for, in the order they're shown. */
export const OUTCOME_KEYS: OutcomeKey[] = [
  "REFUND",
  "EXCHANGE",
  "STORE_CREDIT",
  "GIFT_CARD",
];

export type RegionalPolicyRow = RegionalPolicy & {
  outcomes: RegionalPolicyOutcome[];
};

/**
 * The country an order shipped to, as an ISO code.
 *
 * Orders arrive in two shapes — REST webhooks in snake_case, the GraphQL
 * backfill in camelCase — and rows predating either are still in the table,
 * so every spelling is tried. Null when the address carries no code at all;
 * such an order follows the store policy.
 */
export const orderCountry = (shippingAddress: unknown): string | null => {
  if (!shippingAddress || typeof shippingAddress !== "object") return null;
  const a = shippingAddress as Record<string, unknown>;
  for (const key of ["countryCodeV2", "country_code", "countryCode"]) {
    const value = a[key];
    if (typeof value === "string" && /^[A-Za-z]{2}$/.test(value.trim())) {
      return value.trim().toUpperCase();
    }
  }
  return null;
};

/** A stored policy, reduced to the terms the engines read. */
export const toTerms = (row: RegionalPolicyRow | null | undefined): RegionalTerms | null => {
  if (!row) return null;
  const outcomes: OutcomeMap = {};
  for (const outcome of row.outcomes) {
    if (!OUTCOME_KEYS.includes(outcome.resolution as OutcomeKey)) continue;
    outcomes[outcome.resolution as OutcomeKey] = {
      enabled: outcome.enabled,
      windowDays: outcome.windowDays,
      fee:
        outcome.feeType && outcome.feeValue !== null
          ? { type: outcome.feeType, value: outcome.feeValue }
          : null,
    };
  }
  return {
    id: row.id,
    name: row.name,
    destinationId: row.destinationId,
    instructions: row.instructions,
    windowStartsFrom: row.windowStartsFrom,
    bypassReview: row.bypassReview,
    allowInstantExchange: row.allowInstantExchange,
    allowAdvancedExchange: row.allowAdvancedExchange,
    inventoryLocationIds: row.inventoryLocationIds,
    exchangeShippingMethod: row.exchangeShippingMethod,
    outcomes,
  };
};

/**
 * The regional policy that claims an order's shipping country, if any.
 *
 * Read fresh each time rather than pinned to the order: a policy created this
 * morning should govern a return started this afternoon, and a return already
 * submitted keeps its own policy by id regardless.
 */
export const regionalPolicyFor = async (
  merchantId: string,
  order: Pick<Order, "shippingAddress">,
): Promise<RegionalTerms | null> => {
  const country = orderCountry(order.shippingAddress);
  if (!country) return null;
  const row = await prisma.regionalPolicy.findFirst({
    where: { merchantId, countries: { has: country } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include: { outcomes: true },
  });
  return toTerms(row);
};

/** Same, by order id — for the catalogue paths that only hold the id. */
export const regionalTermsForOrder = async (
  merchantId: string,
  orderId: string,
): Promise<RegionalTerms | null> => {
  const order = await prisma.order.findFirst({
    where: { id: orderId, merchantId },
    select: { shippingAddress: true },
  });
  return order ? regionalPolicyFor(merchantId, order) : null;
};

/** The store policy with the order's region, if it has one, laid over it. */
export const effectivePolicyFor = async (
  merchantId: string,
  base: ReturnPolicy,
  order: Pick<Order, "shippingAddress">,
): Promise<EffectivePolicy> =>
  applyRegionalPolicy(base, await regionalPolicyFor(merchantId, order));

/**
 * The policy a submitted return is priced under, for the recomputations that
 * run after submission — inspection, the exchange draft, the payout split.
 * The region is the one recorded on the request, so a return keeps its terms
 * even if the merchant later moves its country to another policy.
 */
export const effectivePolicyForRequest = (request: {
  policy: ReturnPolicy | null;
  regionalPolicy?: RegionalPolicyRow | null;
}): EffectivePolicy | null =>
  request.policy
    ? applyRegionalPolicy(request.policy, toTerms(request.regionalPolicy))
    : null;

/** The include every recomputation needs, so none of them can forget the region. */
export const policyInclude = {
  policy: true,
  regionalPolicy: { include: { outcomes: true } },
} as const;

/**
 * Which Shopify locations decide exchange availability for an order.
 *
 * The region's own list when it has one, else the store's; undefined when
 * neither narrows anything, which lets the catalogue use Shopify's aggregate
 * answer and never ask for stock per location.
 */
export const inventoryScope = async (
  merchantId: string,
  regional: RegionalTerms | null | undefined,
): Promise<string[] | undefined> => {
  if (regional && regional.inventoryLocationIds.length > 0) {
    return regional.inventoryLocationIds;
  }
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { inventoryLocationIds: true },
  });
  return merchant && merchant.inventoryLocationIds.length > 0
    ? merchant.inventoryLocationIds
    : undefined;
};

/** Same, for the paths that only hold the order id. */
export const inventoryScopeFor = async (
  merchantId: string,
  orderId: string,
): Promise<string[] | undefined> =>
  inventoryScope(merchantId, await regionalTermsForOrder(merchantId, orderId));
