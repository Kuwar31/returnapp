import { Prisma, type ResolutionType, type ReturnPolicy } from "@prisma/client";
import { percentOf, round2, toDecimal, ZERO } from "../../lib/money.js";

export interface QuoteLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
}

export interface Quote {
  itemsSubtotal: Prisma.Decimal;
  bonusCredit: Prisma.Decimal;
  restockingFee: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  /** What the shopper receives: subtotal + bonus - fees, floored at zero. */
  estimatedTotal: Prisma.Decimal;
  /** Extra the shopper owes when exchange items cost more than the return. */
  amountDue: Prisma.Decimal;
}

const CREDIT_RESOLUTIONS: ResolutionType[] = [
  "STORE_CREDIT",
  "EXCHANGE",
  "INSTANT_EXCHANGE",
];

/**
 * Computes the money breakdown for a return. Same function serves the
 * shopper's live estimate and the figures persisted on submit, so the number
 * they were shown is the number that gets stored.
 */
export const quoteReturn = ({
  lines,
  policy,
  resolution,
  exchangeValue = ZERO,
}: {
  lines: QuoteLine[];
  policy: ReturnPolicy;
  resolution: ResolutionType;
  /** Total price of the replacement items, for exchanges. */
  exchangeValue?: Prisma.Decimal;
}): Quote => {
  const itemsSubtotal = round2(
    lines.reduce(
      (sum, line) => sum.add(toDecimal(line.unitPrice).mul(line.quantity)),
      ZERO,
    ),
  );

  const takesCredit = CREDIT_RESOLUTIONS.includes(resolution);

  // Bonus credit is the carrot for not taking cash back.
  const bonusCredit = takesCredit
    ? percentOf(itemsSubtotal, policy.bonusCreditPercent)
    : ZERO;

  const restockingFee = percentOf(
    itemsSubtotal,
    policy.restockingFeePercent,
  );

  const shippingFee =
    takesCredit && policy.waiveShippingOnCredit
      ? ZERO
      : round2(toDecimal(policy.returnShippingFee));

  const gross = itemsSubtotal
    .add(bonusCredit)
    .sub(restockingFee)
    .sub(shippingFee);

  // Fees can exceed the item value on a cheap item; never hand back a negative.
  const credited = gross.lessThan(0) ? ZERO : round2(gross);

  const exchangeGap = round2(toDecimal(exchangeValue).sub(credited));
  const amountDue = exchangeGap.greaterThan(0) ? exchangeGap : ZERO;

  // On an exchange the credit is consumed by the replacement, so what's left
  // over is what actually gets paid out.
  const estimatedTotal =
    takesCredit && toDecimal(exchangeValue).greaterThan(0)
      ? round2(
          credited.sub(toDecimal(exchangeValue)).greaterThan(0)
            ? credited.sub(toDecimal(exchangeValue))
            : ZERO,
        )
      : credited;

  return {
    itemsSubtotal,
    bonusCredit,
    restockingFee,
    shippingFee,
    estimatedTotal,
    amountDue,
  };
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
