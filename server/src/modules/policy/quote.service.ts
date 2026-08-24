import { Prisma, type ResolutionType, type ReturnPolicy } from "@prisma/client";
import { percentOf, round2, toDecimal, ZERO } from "../../lib/money.js";

export interface QuoteLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
  /** How this specific item is being compensated. */
  resolution: ResolutionType;
  /** Total price of the replacement chosen for this line, if it's an exchange. */
  exchangeValue?: Prisma.Decimal;
}

/** Per-line breakdown, so the portal can show the maths item by item. */
export interface QuoteLineResult {
  resolution: ResolutionType;
  itemsSubtotal: Prisma.Decimal;
  bonusCredit: Prisma.Decimal;
  restockingFee: Prisma.Decimal;
  exchangeValue: Prisma.Decimal;
  /** What this line contributes to the payout. */
  credited: Prisma.Decimal;
  /** What this line adds to the amount owed, when the swap costs more. */
  due: Prisma.Decimal;
}

export interface Quote {
  itemsSubtotal: Prisma.Decimal;
  bonusCredit: Prisma.Decimal;
  restockingFee: Prisma.Decimal;
  /** What the shopper receives: subtotal + bonus - fees, floored at zero. */
  estimatedTotal: Prisma.Decimal;
  /** Extra the shopper owes when exchange items cost more than the return. */
  amountDue: Prisma.Decimal;
  /** Payout split by destination, so resolution knows what to issue where. */
  byResolution: Map<ResolutionType, Prisma.Decimal>;
  lines: QuoteLineResult[];
}

/**
 * Resolutions that keep the money inside the store. These earn bonus credit,
 * because the merchant retains the revenue.
 */
const CREDIT_RESOLUTIONS: ResolutionType[] = [
  "STORE_CREDIT",
  "GIFT_CARD",
  "EXCHANGE",
  "INSTANT_EXCHANGE",
];

export const keepsMoneyInStore = (resolution: ResolutionType): boolean =>
  CREDIT_RESOLUTIONS.includes(resolution);

/**
 * Computes the money breakdown for a return.
 *
 * Each line is priced by its own resolution — bonus credit and restocking apply
 * per item — and the results are then summed.
 *
 * Serves both the shopper's live estimate and the figures persisted on submit,
 * so the number they were shown is the number that gets stored.
 */
export const quoteReturn = ({
  lines,
  policy,
}: {
  lines: QuoteLine[];
  policy: ReturnPolicy;
}): Quote => {
  const results: QuoteLineResult[] = lines.map((line) => {
    const subtotal = round2(toDecimal(line.unitPrice).mul(line.quantity));
    const takesCredit = keepsMoneyInStore(line.resolution);

    const bonusCredit = takesCredit
      ? percentOf(subtotal, policy.bonusCreditPercent)
      : ZERO;
    const restockingFee = percentOf(subtotal, policy.restockingFeePercent);

    const gross = subtotal.add(bonusCredit).sub(restockingFee);
    // Fees can exceed a cheap item's value; never hand back a negative.
    const value = gross.lessThan(0) ? ZERO : round2(gross);

    const exchangeValue = round2(toDecimal(line.exchangeValue ?? ZERO));

    // An exchange consumes its own line's value. Anything left over is still
    // owed to the shopper; anything short is owed by them.
    const credited = exchangeValue.greaterThan(0)
      ? round2(
          value.sub(exchangeValue).greaterThan(0)
            ? value.sub(exchangeValue)
            : ZERO,
        )
      : value;
    const due = exchangeValue.greaterThan(value)
      ? round2(exchangeValue.sub(value))
      : ZERO;

    return {
      resolution: line.resolution,
      itemsSubtotal: subtotal,
      bonusCredit,
      restockingFee,
      exchangeValue,
      credited,
      due,
    };
  });

  const sum = (pick: (r: QuoteLineResult) => Prisma.Decimal) =>
    round2(results.reduce((acc, r) => acc.add(pick(r)), ZERO));

  const itemsSubtotal = sum((r) => r.itemsSubtotal);
  const bonusCredit = sum((r) => r.bonusCredit);
  const restockingFee = sum((r) => r.restockingFee);
  const amountDue = sum((r) => r.due);

  const creditedTotal = sum((r) => r.credited);
  const estimatedTotal = creditedTotal.lessThan(0) ? ZERO : round2(creditedTotal);

  /**
   * Where each part of the payout is destined. Resolution reads this to know
   * how much to refund, how much to credit and how much to put on a gift card,
   * rather than assuming a single destination for the whole return.
   */
  const byResolution = new Map<ResolutionType, Prisma.Decimal>();
  for (const r of results) {
    if (r.credited.lessThanOrEqualTo(0)) continue;
    byResolution.set(
      r.resolution,
      round2((byResolution.get(r.resolution) ?? ZERO).add(r.credited)),
    );
  }

  return {
    itemsSubtotal,
    bonusCredit,
    restockingFee,
    estimatedTotal,
    amountDue,
    byResolution,
    lines: results,
  };
};

/**
 * A single label for a return whose lines may differ, used in lists and on the
 * Shopify return. "MIXED" isn't a real ResolutionType, so the dominant one by
 * value wins and the per-line detail stays authoritative.
 */
export const summaryResolution = (
  lines: Array<{ resolution: ResolutionType; itemsSubtotal: Prisma.Decimal }>,
): ResolutionType => {
  const totals = new Map<ResolutionType, Prisma.Decimal>();
  for (const line of lines) {
    totals.set(
      line.resolution,
      (totals.get(line.resolution) ?? ZERO).add(line.itemsSubtotal),
    );
  }
  let winner: ResolutionType = "REFUND";
  let best = ZERO;
  for (const [resolution, total] of totals) {
    if (total.greaterThan(best)) {
      best = total;
      winner = resolution;
    }
  }
  return winner;
};

/** Whether a submitted request can skip manual review. */
export const qualifiesForAutoApproval = (
  policy: ReturnPolicy,
  quote: Quote,
): boolean => {
  if (!policy.autoApprove) return false;
  if (policy.autoApproveUnder === null) return true;
  return quote.itemsSubtotal.lessThanOrEqualTo(
    toDecimal(policy.autoApproveUnder),
  );
};
