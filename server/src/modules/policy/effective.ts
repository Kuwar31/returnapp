import type {
  Prisma,
  ResolutionType,
  ReturnPolicy,
  WindowStart,
} from "@prisma/client";
import { ZERO } from "../../lib/money.js";

/**
 * A regional policy, reduced to what the eligibility and quote engines need.
 *
 * Pure types and functions only: this file is imported by both engines, which
 * are deliberately free of database access so they can be reasoned about and
 * tested without one. Reading the rows is regional.service's job.
 */

/** A handling fee: flat per return, or a share of the returned value. */
export interface FeeRule {
  type: "FLAT" | "PERCENT";
  value: Prisma.Decimal;
}

/** The terms of one outcome under a regional policy. */
export interface OutcomeTerms {
  enabled: boolean;
  /** Days from the start event; null is an unlimited window. */
  windowDays: number | null;
  /** Null charges nothing. */
  fee: FeeRule | null;
}

/**
 * The outcomes a regional policy speaks for. An instant exchange has no row of
 * its own and follows the exchange terms — see outcomeKey.
 */
export type OutcomeKey = "REFUND" | "EXCHANGE" | "STORE_CREDIT" | "GIFT_CARD";
export type OutcomeMap = Partial<Record<OutcomeKey, OutcomeTerms>>;

export interface RegionalTerms {
  id: string;
  name: string;
  destinationLocationId: string | null;
  instructions: string[];
  windowStartsFrom: WindowStart;
  bypassReview: boolean;
  outcomes: OutcomeMap;
}

/**
 * The store policy with a region's overrides laid on top.
 *
 * Structurally a ReturnPolicy, so every existing caller keeps working, plus
 * the per-outcome terms the engines consult when present. `regional` is null
 * for an order no regional policy claims — the everyday case, in which every
 * figure below is exactly the store policy's.
 */
export type EffectivePolicy = ReturnPolicy & {
  outcomes?: OutcomeMap;
  regional?: RegionalTerms | null;
};

/** Which outcome row a resolution is governed by. */
export const outcomeKey = (resolution: ResolutionType): OutcomeKey | null => {
  switch (resolution) {
    case "REFUND":
    case "EXCHANGE":
    case "STORE_CREDIT":
    case "GIFT_CARD":
      return resolution;
    case "INSTANT_EXCHANGE":
      return "EXCHANGE";
    default:
      return null;
  }
};

/** The terms for a resolution, or undefined when no regional policy applies. */
export const termsFor = (
  outcomes: OutcomeMap | undefined,
  resolution: ResolutionType,
): OutcomeTerms | undefined => {
  if (!outcomes) return undefined;
  const key = outcomeKey(resolution);
  return key ? outcomes[key] : undefined;
};

/**
 * The longest finite window among the outcomes that are on.
 *
 * What "the return window" means once each outcome has its own: the last day
 * anything at all can still be started. Null when every open outcome is
 * unlimited, or nothing is on.
 */
export const longestWindow = (outcomes: OutcomeMap): number | null => {
  let longest: number | null = null;
  for (const terms of Object.values(outcomes)) {
    if (!terms?.enabled || terms.windowDays === null) continue;
    if (longest === null || terms.windowDays > longest) longest = terms.windowDays;
  }
  return longest;
};

/**
 * Lays a region's terms over the store policy.
 *
 * Only what the region is allowed to decide changes: which outcomes are on,
 * the start event, whether review is skipped, and — through `outcomes` — the
 * windows and fees. Tag rules, bonus credit, exchange chains and the rest are
 * the store's, untouched, which is the point of an overlay rather than a copy.
 *
 * The store's restocking percentage is zeroed because the region's fees
 * replace it; the quote engine reads them from `outcomes` instead. An instant
 * exchange stays on only where the store offers it *and* the region keeps
 * exchanges open, since it is a kind of exchange rather than a fifth outcome.
 */
export const applyRegionalPolicy = (
  base: ReturnPolicy,
  regional: RegionalTerms | null,
): EffectivePolicy => {
  if (!regional) return { ...base, regional: null };

  const on = (key: OutcomeKey) => regional.outcomes[key]?.enabled === true;
  const longest = longestWindow(regional.outcomes);

  return {
    ...base,
    allowRefund: on("REFUND"),
    allowStoreCredit: on("STORE_CREDIT"),
    allowGiftCard: on("GIFT_CARD"),
    allowExchange: on("EXCHANGE"),
    allowInstantExchange: base.allowInstantExchange && on("EXCHANGE"),
    windowStartsFrom: regional.windowStartsFrom,
    returnWindowDays: longest ?? base.returnWindowDays,
    autoApprove: regional.bypassReview,
    autoApproveUnder: regional.bypassReview ? null : base.autoApproveUnder,
    restockingFeePercent: ZERO,
    outcomes: regional.outcomes,
    regional,
  };
};
