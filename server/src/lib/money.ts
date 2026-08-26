import { Prisma } from "@prisma/client";

export type Money = Prisma.Decimal;

export const toDecimal = (value: Prisma.Decimal.Value): Prisma.Decimal =>
  new Prisma.Decimal(value);

export const ZERO = toDecimal(0);

/** Rounds half-up to 2dp — the convention for customer-facing totals. */
export const round2 = (value: Prisma.Decimal): Prisma.Decimal =>
  value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export const percentOf = (
  amount: Prisma.Decimal,
  percent: Prisma.Decimal.Value,
): Prisma.Decimal => round2(amount.mul(toDecimal(percent)).div(100));

/** Decimals don't survive JSON.stringify as numbers, so serialize explicitly. */
export const serializeMoney = (value: Prisma.Decimal | null): number | null =>
  value === null ? null : value.toNumber();

export const formatMoney = (
  amount: Prisma.Decimal | number,
  currency: string,
): string => {
  const value = typeof amount === "number" ? amount : amount.toNumber();
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
};

// ---------------------------------------------------------------------------
// Display currency
// ---------------------------------------------------------------------------

/** The presentment figures an order carries, if it has any. */
export interface OrderRateSource {
  currency: string;
  total: Prisma.Decimal;
  presentmentCurrency: string | null;
  presentmentTotal: Prisma.Decimal | null;
}

/**
 * Converts a shop-currency amount into the currency the customer was charged.
 *
 * Two callers, one rule. The exchange draft order bills in it because Shopify
 * must charge the shopper in the currency they actually paid; the serializers
 * render in it when the merchant has asked to see presentment figures.
 *
 * The rate comes from the order itself — presentment total over shop total —
 * not from a feed. That matters: rates differ per order because they were
 * placed at different times, and a single global rate would silently restate
 * historical figures the customer has already seen.
 *
 * Falls back to `fallbackCurrency` whenever the rate can't be derived, so an
 * order predating presentment capture degrades to "unconverted" rather than
 * wrong. That argument is required rather than defaulted: a hardcoded fallback
 * once rendered a EUR store's figures as USD when a caller forgot to load the
 * order, and nothing failed loudly.
 */
export const forDisplay = (
  amount: Prisma.Decimal | null,
  order: OrderRateSource | null | undefined,
  mode: "SHOP" | "PRESENTMENT",
  /** Used when the order isn't loaded. See the note above on why it's required. */
  fallbackCurrency: string,
): { amount: number | null; currency: string } => {
  const shopCurrency = order?.currency ?? fallbackCurrency;
  if (amount === null || amount === undefined) {
    return { amount: null, currency: shopCurrency };
  }
  if (mode === "SHOP" || !order) {
    return { amount: amount.toNumber(), currency: shopCurrency };
  }

  const target = order.presentmentCurrency;
  if (!target || target === order.currency) {
    return { amount: amount.toNumber(), currency: shopCurrency };
  }

  const shopTotal = toDecimal(order.total);
  const presentmentTotal =
    order.presentmentTotal === null ? null : toDecimal(order.presentmentTotal);
  // A zero-value order carries no usable rate — free or fully discounted.
  if (!presentmentTotal || shopTotal.lessThanOrEqualTo(0)) {
    return { amount: amount.toNumber(), currency: shopCurrency };
  }

  const rate = presentmentTotal.div(shopTotal);
  return { amount: round2(amount.mul(rate)).toNumber(), currency: target };
};

/** Curries `forDisplay` for a single order, since serializers convert many. */
export const displayConverter = (
  order: OrderRateSource | null | undefined,
  mode: "SHOP" | "PRESENTMENT",
  fallbackCurrency: string,
) => {
  const currency = forDisplay(ZERO, order, mode, fallbackCurrency).currency;
  return {
    currency,
    money: (value: Prisma.Decimal | null) =>
      forDisplay(value, order, mode, fallbackCurrency).amount,
  };
};
