import type {
  Order,
  OrderLineItem,
  ResolutionType,
  ReturnPolicy,
} from "@prisma/client";
import { toDecimal } from "../../lib/money.js";
import { canExchangeAgain } from "../returns/exchange-chain.js";

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
  /** Why it can't be returned, in English, for the admin and the logs. */
  ineligibleReason: string | null;
  /**
   * The same answer as a translation key, for the portal.
   *
   * The portal speaks thirteen languages and this sentence is generated on the
   * server, which knows none of them. Sending the key and its values lets the
   * browser render it in the shopper's language; the English above stays for
   * the admin, which is English-only, and for anything logged.
   */
  ineligibleCode: string | null;
  ineligibleVars: Record<string, string | number> | null;
  /**
   * What this particular item may become.
   *
   * Per line rather than per order, because a product tag can narrow one item
   * without touching the rest of the parcel — an exchange-only jacket beside a
   * freely refundable shirt is the whole point of the feature.
   */
  allowedResolutions: ResolutionType[];
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
    /**
     * Options were recorded and every one was Shopify's "Title" placeholder,
     * which means the product genuinely has no options. Falling back to the
     * title here would print "Default Title" at a shopper as though it were a
     * choice they made.
     */
    return null;
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

/**
 * Whether a line carries any of the named tags.
 *
 * Both sides are lowercased and trimmed: a merchant types "Final Sale" into
 * Shopify and "final-sale" into this app, and refusing to match those would
 * make the feature look broken rather than strict.
 */
const hasAnyTag = (line: OrderLineItem, tags: string[]): boolean => {
  if (tags.length === 0) return false;
  const wanted = new Set(
    tags.map((t) => t.trim().toLowerCase()).filter(Boolean),
  );
  if (wanted.size === 0) return false;
  return line.productTags.some((t) => wanted.has(t.trim().toLowerCase()));
};

/**
 * Money that stays with the store, as opposed to a refund to the card.
 *
 * What "exchange only" permits, following Loop: a swap, one of the merchant's
 * advanced-exchange lists, store credit or a gift card. The one thing it
 * excludes is cash leaving the business, which is the reason a merchant tags an
 * item this way in the first place.
 */
const EXCHANGE_RESOLUTIONS: ResolutionType[] = [
  "EXCHANGE",
  "INSTANT_EXCHANGE",
];

const KEEPS_MONEY_IN_STORE: ResolutionType[] = [
  "EXCHANGE",
  "INSTANT_EXCHANGE",
  "STORE_CREDIT",
  "GIFT_CARD",
];

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
   * How many exchanges this order is from an original purchase, walked from
   * our own records before this is called. Zero for something bought outright.
   *
   * Passed in rather than looked up, because this function is pure — which is
   * what lets the admin, the portal and the tests all reason about the same
   * decision without a database between them.
   */
  exchangeGeneration = 0,
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

  const policyResolutions = allowedResolutions(policy);

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

    /*
      A replacement is zeroed out only while the chain is closed. With
      exchanges-of-exchanges switched on it is an ordinary line again, and
      leaving the count at zero would have reported it as "already returned" —
      a true-sounding sentence about the wrong thing.
    */
    const returnable =
      isExchangeReplacement && !policy.allowExchangeOfExchange
        ? 0
        : fromShopify === undefined
          ? ours
          : Math.min(ours, fromShopify);

    /**
     * The merchant's tag rules, read from the snapshot the order synced with.
     *
     * Checked after the window rather than before it: an item outside the
     * window is closed for a reason the shopper can act on next time, and
     * leading with "final sale" would bury the deadline.
     */
    const tagRules = policy.tagRulesEnabled;
    const finalSaleByTag = tagRules && hasAnyTag(line, policy.finalSaleTags);
    const exchangeOnly = tagRules && hasAnyTag(line, policy.exchangeOnlyTags);

    /**
     * How many exchanges deep this particular line is.
     *
     * The order's own depth, plus one where Shopify says the line itself is a
     * replacement — a native exchange puts the new item on the original order,
     * so the order is still generation zero while that line is not.
     */
    const lineGeneration = exchangeGeneration + (isExchangeReplacement ? 1 : 0);
    const exchangeable = canExchangeAgain(lineGeneration, policy);

    let ineligibleReason: string | null = null;
    let ineligibleCode: string | null = null;
    let ineligibleVars: Record<string, string | number> | null = null;
    if (isExchangeReplacement && !policy.allowExchangeOfExchange) {
      /*
        Closed outright, which is what this app has always done with a
        replacement. Opening the chain is what the setting is for; until a
        merchant does, nothing about this changes.
      */
      ineligibleReason =
        "This item is a replacement from an earlier exchange, so it can't be returned again.";
      ineligibleCode = "ineligible.replacement";
    } else if (!anchor) {
      ineligibleReason = "This item hasn't shipped yet.";
      ineligibleCode = "ineligible.unshipped";
    } else if (!withinWindow) {
      ineligibleReason = `The ${policy.returnWindowDays}-day return window has closed.`;
      ineligibleCode = "ineligible.windowClosed";
      ineligibleVars = { days: policy.returnWindowDays };
    } else if (line.finalSale && !policy.allowFinalSale) {
      ineligibleReason = "Final sale items can't be returned.";
      ineligibleCode = "ineligible.finalSale";
    } else if (finalSaleByTag) {
      ineligibleReason = "This item is final sale and can't be returned.";
      ineligibleCode = "ineligible.finalSale";
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
      if (unshipped > 0) {
        ineligibleReason = "This item hasn't shipped yet.";
        ineligibleCode = "ineligible.unshipped";
      } else if (fromShopify === 0 && ours > 0) {
        ineligibleReason = "This item already has a return open in Shopify.";
        ineligibleCode = "ineligible.returnOpen";
      } else {
        ineligibleReason = "This item has already been returned.";
        ineligibleCode = "ineligible.alreadyReturned";
      }
    }

    /**
     * An exchange-only item keeps whatever the policy already allows, minus a
     * refund. Intersected rather than replaced: a store that doesn't offer gift
     * cards shouldn't start offering them because a product was tagged.
     */
    let lineResolutions = exchangeOnly
      ? policyResolutions.filter((r) => KEEPS_MONEY_IN_STORE.includes(r))
      : policyResolutions;

    /**
     * Out of exchanges, but not out of options.
     *
     * Once the chain reaches its limit the swap is what stops being offered —
     * the item can still be refunded or credited. Closing it entirely would
     * strand a shopper holding something they never chose to buy twice.
     */
    if (!exchangeable) {
      lineResolutions = lineResolutions.filter(
        (r) => !EXCHANGE_RESOLUTIONS.includes(r),
      );
    }

    /**
     * Tagged exchange-only, but the store offers nothing that qualifies — no
     * exchanges, no credit, no gift cards. Saying the item can't be returned is
     * more honest than offering a choice of nothing.
     */
    if (ineligibleReason === null && lineResolutions.length === 0) {
      if (!exchangeable) {
        ineligibleReason =
          "This item has already been exchanged as many times as this store allows.";
        ineligibleCode = "ineligible.exchangeLimit";
      } else {
        ineligibleReason =
          "This item can only be exchanged, and no exchange options are available.";
        ineligibleCode = "ineligible.exchangeOnlyUnavailable";
      }
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
      ineligibleCode,
      ineligibleVars,
      allowedResolutions: lineResolutions,
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
