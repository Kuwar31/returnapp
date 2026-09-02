import { Prisma, type ResolutionType, type ReturnPolicy } from "@prisma/client";
import { percentOf, round2, toDecimal, ZERO } from "../../lib/money.js";

export interface QuoteLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
  /** How this specific item is being compensated. */
  resolution: ResolutionType;
  /** Total price of the replacement chosen for this line, if it's an exchange. */
  exchangeValue?: Prisma.Decimal;
  /**
   * The replacement is another variant of the same product — a size swap.
   *
   * Only these are governed by the variant-difference setting. Swapping a
   * 5,700 board for a 3,300 one is a real change of mind about what to own,
   * and a merchant who offered to cover the odd rupee of exchange-rate drift
   * did not offer to hand over 2,400.
   */
  sameProduct?: boolean;
}

/**
 * The merchant covers any gap between a returned item and its replacement.
 *
 * The gap on a size swap is frequently not a real price difference at all: the
 * returned line was charged at the order's own exchange rate, while the
 * catalogue price is today's, so the same product in another size can appear
 * to be worth a few rupees more or less than itself. Absorbing settles both
 * directions — nothing owed, nothing credited.
 */
export type ExchangeDifference = "SAME_PRICE_ONLY" | "CHARGE" | "ABSORB";

/**
 * A credit sweetener, expressed either way.
 *
 * PERCENT scales with what came back and can therefore be applied per line.
 * FIXED cannot: a flat 10 is an incentive to exchange, not a multiplier on how
 * many items were in the parcel, so it is added once per return.
 */
export interface BonusRule {
  type: "PERCENT" | "FIXED";
  value: Prisma.Decimal;
}

/** The resolutions that hand back goods rather than money. */
export const EXCHANGE_RESOLUTIONS: ResolutionType[] = [
  "EXCHANGE",
  "INSTANT_EXCHANGE",
];

/** What a bonus is worth against a given base. Zero for an unset or empty one. */
export const bonusAmount = (
  rule: BonusRule | undefined,
  base: Prisma.Decimal,
): Prisma.Decimal =>
  !rule || toDecimal(rule.value).lessThanOrEqualTo(0)
    ? ZERO
    : rule.type === "PERCENT"
      ? percentOf(base, rule.value)
      : round2(toDecimal(rule.value));

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
  /** The gap the merchant covered on this line, when they're absorbing it. */
  absorbed: Prisma.Decimal;
}

export interface Quote {
  itemsSubtotal: Prisma.Decimal;
  bonusCredit: Prisma.Decimal;
  restockingFee: Prisma.Decimal;
  /** What the shopper receives: subtotal + bonus - fees, floored at zero. */
  estimatedTotal: Prisma.Decimal;
  /** Extra the shopper owes when exchange items cost more than the return. */
  amountDue: Prisma.Decimal;
  /**
   * What the merchant covered so the shopper didn't have to.
   *
   * Reported rather than left implicit: absorbing makes a real gap vanish from
   * every other figure, and a summary that shows 5,699.88 coming back,
   * 5,527.43 going out and a 0.00 refund is arithmetic the shopper can't
   * follow. This is the missing line.
   */
  absorbedDifference: Prisma.Decimal;
  /**
   * The "shop now" sweetener as applied, so submit can persist the figure the
   * shopper was actually quoted instead of recomputing it from a base this
   * function may have narrowed.
   */
  shopBonus: Prisma.Decimal;
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
  shopNow,
  exchangeBonus,
  variantDifference = "CHARGE",
}: {
  lines: QuoteLine[];
  policy: ReturnPolicy;
  /**
   * How a per-line swap's price gap is settled. Applies only to those: a "shop
   * now" basket is a deliberate purchase, and absorbing its cost would hand the
   * shopper anything in the catalogue for free.
   */
  variantDifference?: ExchangeDifference;
  /**
   * The bonus for exchanging rather than taking the money — size swaps and the
   * merchant's advanced-exchange lists alike. Omitted, the policy's percentage
   * applies, which is what happened before this existed.
   */
  exchangeBonus?: BonusRule;
  /**
   * "Shop now": one basket bought with every line's credit pooled together,
   * rather than each line netting against its own replacement.
   *
   * Applied after the per-line pass rather than inside it, because a basket has
   * no line to belong to — three returned items paying for one jacket cannot be
   * expressed as three per-line swaps. Omitted, every figure below is computed
   * exactly as it was before this existed.
   */
  shopNow?: { cartTotal: Prisma.Decimal; bonus: BonusRule };
}): Quote => {
  const results: QuoteLineResult[] = lines.map((line) => {
    const subtotal = round2(toDecimal(line.unitPrice).mul(line.quantity));
    const takesCredit = keepsMoneyInStore(line.resolution);

    const isExchange = EXCHANGE_RESOLUTIONS.includes(line.resolution);
    /**
     * A percentage exchange bonus replaces the policy's for exchange lines; a
     * flat one contributes nothing here and is added once to the return below.
     */
    const bonusCredit = !takesCredit
      ? ZERO
      : isExchange && exchangeBonus
        ? exchangeBonus.type === "PERCENT"
          ? bonusAmount(exchangeBonus, subtotal)
          : ZERO
        : percentOf(subtotal, policy.bonusCreditPercent);
    const restockingFee = percentOf(subtotal, policy.restockingFeePercent);

    const gross = subtotal.add(bonusCredit).sub(restockingFee);
    // Fees can exceed a cheap item's value; never hand back a negative.
    const value = gross.lessThan(0) ? ZERO : round2(gross);

    const exchangeValue = round2(toDecimal(line.exchangeValue ?? ZERO));

    /**
     * Absorbed swaps settle flat: the shopper gets the replacement, pays
     * nothing and is owed nothing, whichever way the gap runs. The exchange
     * value itself is left truthful, because the draft order still has to buy
     * the real item at the real price — only who covers the gap changes.
     */
    const absorbed =
      variantDifference === "ABSORB" &&
      exchangeValue.greaterThan(0) &&
      line.sameProduct === true;

    // An exchange consumes its own line's value. Anything left over is still
    // owed to the shopper; anything short is owed by them.
    const credited = absorbed
      ? ZERO
      : exchangeValue.greaterThan(0)
        ? round2(
            value.sub(exchangeValue).greaterThan(0)
              ? value.sub(exchangeValue)
              : ZERO,
          )
        : value;
    const due =
      !absorbed && exchangeValue.greaterThan(value)
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
      // The gap either way, since absorbing covers both directions.
      absorbed: absorbed ? round2(exchangeValue.sub(value).abs()) : ZERO,
    };
  });

  const sum = (pick: (r: QuoteLineResult) => Prisma.Decimal) =>
    round2(results.reduce((acc, r) => acc.add(pick(r)), ZERO));

  const itemsSubtotal = sum((r) => r.itemsSubtotal);
  const restockingFee = sum((r) => r.restockingFee);
  const creditedTotal = sum((r) => r.credited);

  const shopping = shopNow !== undefined;
  /**
   * The flat "spend it with us" sweetener counts as bonus credit like the
   * percentage does, so it shows up in the same place on every screen and in
   * the same total the shopper is promised.
   */
  /**
   * Bonuses that belong to the return rather than to any one line.
   *
   * A flat exchange bonus lands here for the reason given on BonusRule, and a
   * shop-now bonus always has: both are one sweetener per return. A percentage
   * shop-now bonus is taken against what came back, the same base the policy's
   * percentage uses, so the two are comparable.
   */
  const flatExchangeBonus =
    exchangeBonus?.type === "FIXED" &&
    results.some(
      (r) =>
        EXCHANGE_RESOLUTIONS.includes(r.resolution) &&
        r.exchangeValue.greaterThan(0),
    )
      ? bonusAmount(exchangeBonus, itemsSubtotal)
      : ZERO;
  /**
   * What the basket is actually being bought with.
   *
   * Only lines with no replacement of their own fund it — a line already
   * swapped for a specific item has spent its value there. Basing the
   * sweetener on the whole return would pay a bonus on goods that never
   * reached the pool, and would stack on top of the exchange bonus that line
   * has already earned. With nothing swapped per line, which is the ordinary
   * case, this is the whole subtotal and nothing changes.
   */
  const poolBase = round2(
    results.reduce(
      (acc, r) => (r.exchangeValue.greaterThan(0) ? acc : acc.add(r.itemsSubtotal)),
      ZERO,
    ),
  );
  const shopBonus = shopping ? bonusAmount(shopNow.bonus, poolBase) : ZERO;
  const extraCredit = round2(flatExchangeBonus.add(shopBonus));

  const bonusCredit = round2(sum((r) => r.bonusCredit).add(extraCredit));

  /**
   * One pool against one basket. Everything the lines credit — plus the extra —
   * buys the cart; what's left over is still paid out, and what's short is owed
   * at checkout.
   */
  const pool = shopping ? round2(creditedTotal.add(extraCredit)) : creditedTotal;
  const shortfall = shopping
    ? round2(
        shopNow.cartTotal.sub(pool).greaterThan(0)
          ? shopNow.cartTotal.sub(pool)
          : ZERO,
      )
    : ZERO;

  const lineDue = sum((r) => r.due);
  /**
   * Off a swap's balance first, and only then into the payout. A shopper owed
   * 20 on an upgrade and given a flat 10 should owe 10, not owe 20 and be
   * handed 10 separately.
   */
  const dueOffset = shopping
    ? ZERO
    : lineDue.lessThan(extraCredit)
      ? lineDue
      : extraCredit;

  const leftover = shopping
    ? round2(
        pool.sub(shopNow.cartTotal).greaterThan(0)
          ? pool.sub(shopNow.cartTotal)
          : ZERO,
      )
    : round2(creditedTotal.add(extraCredit.sub(dueOffset)));

  const amountDue = round2(lineDue.sub(dueOffset).add(shortfall));
  const absorbedDifference = sum((r) => r.absorbed);
  const estimatedTotal = leftover.lessThan(0) ? ZERO : round2(leftover);

  /**
   * Where each part of the payout is destined. Resolution reads this to know
   * how much to refund, how much to credit and how much to put on a gift card,
   * rather than assuming a single destination for the whole return.
   */
  const byResolution = new Map<ResolutionType, Prisma.Decimal>();
  if (shopping) {
    /**
     * The basket has already absorbed the pool, so the only thing left to pay
     * out is whatever it didn't spend. Summing the lines here instead would
     * promise the shopper their full credit *and* the goods it bought.
     */
    if (leftover.greaterThan(0)) byResolution.set("EXCHANGE", leftover);
  } else {
    for (const r of results) {
      if (r.credited.lessThanOrEqualTo(0)) continue;
      byResolution.set(
        r.resolution,
        round2((byResolution.get(r.resolution) ?? ZERO).add(r.credited)),
      );
    }
  }

  return {
    itemsSubtotal,
    bonusCredit,
    restockingFee,
    estimatedTotal,
    amountDue,
    absorbedDifference,
    shopBonus,
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
