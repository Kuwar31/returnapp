import type {
  Order,
  OrderLineItem,
  ResolutionType,
  ReturnPolicy,
} from "@prisma/client";
import { toDecimal } from "../../lib/money.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface EligibleLineItem {
  id: string;
  title: string;
  variantTitle: string | null;
  /** Display-ready, e.g. "Size: 37". Null when the product has no options. */
  variantLabel: string | null;
  sku: string | null;
  imageUrl: string | null;
  unitPrice: number;
  currency: string;
  /** Units the shopper may still send back on this line. */
  returnableQuantity: number;
  eligible: boolean;
  /** Why it can't be returned, for display next to the item. */
  ineligibleReason: string | null;
}

export interface OrderEligibility {
  withinWindow: boolean;
  windowDays: number;
  /** Null when the window can't start yet (e.g. not delivered). */
  windowClosesAt: Date | null;
  daysRemaining: number | null;
  items: EligibleLineItem[];
  /** True when at least one item can actually be returned. */
  hasEligibleItems: boolean;
  allowedResolutions: ResolutionType[];
}

/**
 * Turns stored variant options into something a shopper can read.
 *
 * Shopify's variantTitle carries only the values, so a single-option product
 * arrived as a bare "37" — or worse, "1" — printed under the product name with
 * nothing to say what it measured. Where the option names were captured, they
 * are put back: "Size: 37", or "Colour: Blue · Size: M".
 *
 * Falls back to the bare title, since orders synced before the names were
 * stored still have to render as they always did.
 */
const variantLabel = (line: OrderLineItem): string | null => {
  const options = line.variantOptions;
  if (Array.isArray(options) && options.length > 0) {
    const parts = options
      .filter(
        (o): o is { name: string; value: string } =>
          Boolean(o) &&
          typeof o === "object" &&
          typeof (o as { name?: unknown }).name === "string" &&
          typeof (o as { value?: unknown }).value === "string",
      )
      // Merchants type option names by hand and this store entered "size", so
      // the first letter is raised rather than printing "size: 1" at a shopper.
      .map((o) => `${o.name.charAt(0).toUpperCase()}${o.name.slice(1)}: ${o.value}`);
    if (parts.length > 0) return parts.join(" · ");
  }
  return line.variantTitle;
};

/** The date the return window is counted from, per the policy. */
const windowAnchor = (order: Order, policy: ReturnPolicy): Date | null => {
  switch (policy.windowStartsFrom) {
    case "ORDER_DATE":
      return order.placedAt;
    case "FULFILLMENT":
      return order.fulfilledAt;
    case "DELIVERY":
      // Fall back to fulfillment when the carrier hasn't confirmed delivery,
      // so a missing delivery webhook can't freeze the window open forever.
      return order.deliveredAt ?? order.fulfilledAt;
    default:
      return order.placedAt;
  }
};

export const allowedResolutions = (
  policy: ReturnPolicy,
): ResolutionType[] => {
  const allowed: ResolutionType[] = [];
  if (policy.allowRefund) allowed.push("REFUND");
  if (policy.allowStoreCredit) allowed.push("STORE_CREDIT");
  if (policy.allowGiftCard) allowed.push("GIFT_CARD");
  if (policy.allowExchange) allowed.push("EXCHANGE");
  if (policy.allowInstantExchange) allowed.push("INSTANT_EXCHANGE");
  return allowed;
};

/**
 * Decides what, if anything, can be returned from an order under a policy.
 * Pure function — no database access — so it can be unit tested and reused
 * by both the portal and the admin "create return on behalf" flow.
 */
export const evaluateOrder = (
  order: Order & { lineItems: OrderLineItem[] },
  policy: ReturnPolicy,
  now: Date = new Date(),
  /**
   * What Shopify says is still returnable, keyed by line-item external id.
   *
   * Shopify is the authority here, not our mirror: a return raised in the
   * Shopify admin, by another app, or a cancelled/restocked line all change
   * returnability without touching our `returnedQuantity`. When supplied, this
   * caps what the shopper is offered — so they are never shown an item that
   * would be rejected later, at approval, after we've already promised it.
   *
   * Omitted (undefined) means "not consulted", and our own bookkeeping is used
   * alone — the correct behaviour for orders that never came from Shopify.
   */
  shopifyReturnable?: Map<string, number>,
  /**
   * Unshipped units per LineItem id. Only used to explain *why* something can't
   * be returned; it never changes whether it can be.
   */
  unfulfilledQuantities?: Map<string, number>,
  /**
   * Lines that are themselves replacements from an earlier exchange.
   *
   * A native exchange puts the replacement on the original order, so without
   * this the portal offers it straight back — a shopper could exchange a
   * replacement, then exchange that, indefinitely, each hop netting against a
   * return that has already been settled.
   */
  exchangeReplacements?: Set<string>,
): OrderEligibility => {
  const anchor = windowAnchor(order, policy);
  const windowClosesAt = anchor
    ? new Date(anchor.getTime() + policy.returnWindowDays * DAY_MS)
    : null;

  // No anchor means the order hasn't shipped yet — nothing to return, but the
  // window hasn't lapsed either.
  const withinWindow = windowClosesAt ? now <= windowClosesAt : false;
  const daysRemaining = windowClosesAt
    ? Math.max(0, Math.ceil((windowClosesAt.getTime() - now.getTime()) / DAY_MS))
    : null;

  const items: EligibleLineItem[] = order.lineItems.map((line) => {
    const ours = Math.max(0, line.quantity - line.returnedQuantity);

    // Take the lower of our count and Shopify's. Shopify can only ever know
    // about less being returnable than we think (returns raised elsewhere), and
    // offering more than it will accept is what produces a failure at approval.
    const fromShopify =
      shopifyReturnable && line.externalId
        ? (shopifyReturnable.get(line.externalId) ?? 0)
        : undefined;
    // Replacements are closed to further returns outright, whatever the counts
    // say — this is the one exclusion that isn't about availability.
    const isExchangeReplacement = Boolean(
      line.externalId && exchangeReplacements?.has(line.externalId),
    );

    const returnable = isExchangeReplacement
      ? 0
      : fromShopify === undefined
        ? ours
        : Math.min(ours, fromShopify);

    let ineligibleReason: string | null = null;
    if (isExchangeReplacement) {
      ineligibleReason =
        "This item is a replacement from an earlier exchange, so it can't be returned again.";
    } else if (!anchor) {
      ineligibleReason = "This item hasn't shipped yet.";
    } else if (!withinWindow) {
      ineligibleReason = `The ${policy.returnWindowDays}-day return window has closed.`;
    } else if (line.finalSale && !policy.allowFinalSale) {
      ineligibleReason = "Final sale items can't be returned.";
    } else if (returnable <= 0) {
      /**
       * Three different reasons look identical from Shopify's side — the line
       * simply isn't among the returnable fulfillments — so the unshipped count
       * is what tells them apart.
       *
       * The one that used to be misreported is an exchange replacement: a
       * native exchange adds it to the original order straight away, so it sits
       * there unfulfilled and got announced as "already has a return open",
       * which was never true and left the shopper looking for a return that
       * didn't exist.
       */
      const unshipped =
        unfulfilledQuantities && line.externalId
          ? (unfulfilledQuantities.get(line.externalId) ?? 0)
          : 0;
      ineligibleReason =
        unshipped > 0
          ? "This item hasn't shipped yet."
          : fromShopify === 0 && ours > 0
            ? "This item already has a return open in Shopify."
            : "This item has already been returned.";
    }

    return {
      id: line.id,
      title: line.title,
      variantTitle: line.variantTitle,
      /**
       * "Size: 37" rather than a bare "37".
       *
       * Shopify's variantTitle is only the values, so a single-option product
       * rendered as a lone number with nothing saying what it measured. Falls
       * back to the bare title for orders synced before the names were stored.
       */
      variantLabel: variantLabel(line),
      sku: line.sku,
      imageUrl: line.imageUrl,
      unitPrice: toDecimal(line.unitPrice).toNumber(),
      currency: line.currency,
      returnableQuantity: returnable,
      eligible: ineligibleReason === null,
      ineligibleReason,
    };
  });

  return {
    withinWindow,
    windowDays: policy.returnWindowDays,
    windowClosesAt,
    daysRemaining,
    items,
    hasEligibleItems: items.some((i) => i.eligible),
    allowedResolutions: allowedResolutions(policy),
  };
};
