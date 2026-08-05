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
    const returnable = Math.max(0, line.quantity - line.returnedQuantity);

    let ineligibleReason: string | null = null;
    if (!anchor) {
      ineligibleReason = "This item hasn't shipped yet.";
    } else if (!withinWindow) {
      ineligibleReason = `The ${policy.returnWindowDays}-day return window has closed.`;
    } else if (line.finalSale && !policy.allowFinalSale) {
      ineligibleReason = "Final sale items can't be returned.";
    } else if (returnable <= 0) {
      ineligibleReason = "This item has already been returned.";
    }

    return {
      id: line.id,
      title: line.title,
      variantTitle: line.variantTitle,
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
