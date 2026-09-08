import { Prisma, type WindowStart } from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import type { OutcomeKey } from "../policy/effective.js";
import {
  OUTCOME_KEYS,
  type RegionalPolicyRow,
} from "../policy/regional.service.js";

/**
 * The merchant's regional return policies — the admin's side of what
 * policy/regional.service reads for the portal.
 */

export interface OutcomeInput {
  enabled: boolean;
  /** Null is an unlimited window. */
  windowDays: number | null;
  /** Null charges nothing; PRODUCT_TAG's value is the fallback for untagged items. */
  fee: { type: "FLAT" | "PERCENT" | "PRODUCT_TAG"; value: number } | null;
}

export interface RegionalPolicyInput {
  name: string;
  countries: string[];
  /** Null means the store's default destination. */
  destinationId: string | null;
  /** Empty defers to the store-wide list. */
  inventoryLocationIds: string[];
  allowInstantExchange: boolean;
  allowAdvancedExchange: boolean;
  exchangeShippingMethod: string | null;
  windowStartsFrom: WindowStart;
  bypassReview: boolean;
  instructions: string[];
  outcomes: Record<OutcomeKey, OutcomeInput>;
}

const include = { outcomes: true } as const;

/**
 * A country's English name, for a validation message a merchant will read.
 * ICU knows every ISO code the picker offers; anything it doesn't is shown
 * as the code, which is still better than nothing.
 */
export const countryName = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
};

export const serializeRegionalPolicy = (row: RegionalPolicyRow) => {
  const outcomes = {} as Record<OutcomeKey, OutcomeInput>;
  for (const key of OUTCOME_KEYS) {
    const found = row.outcomes.find((o) => o.resolution === key);
    outcomes[key] = found
      ? {
          enabled: found.enabled,
          windowDays: found.windowDays,
          fee:
            found.feeType && found.feeValue !== null
              ? { type: found.feeType, value: Number(found.feeValue) }
              : null,
        }
      : { enabled: false, windowDays: null, fee: null };
  }
  return {
    id: row.id,
    name: row.name,
    countries: row.countries,
    destinationId: row.destinationId,
    inventoryLocationIds: row.inventoryLocationIds,
    allowInstantExchange: row.allowInstantExchange,
    allowAdvancedExchange: row.allowAdvancedExchange,
    exchangeShippingMethod: row.exchangeShippingMethod,
    windowStartsFrom: row.windowStartsFrom,
    bypassReview: row.bypassReview,
    instructions: row.instructions,
    sortOrder: row.sortOrder,
    outcomes,
  };
};

export const listRegionalPolicies = async (merchantId: string) =>
  prisma.regionalPolicy.findMany({
    where: { merchantId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    include,
  });

/**
 * Refuses what the database can't: a policy with nothing to offer, a
 * country claimed twice, and a destination that isn't this store's. The
 * second would make which policy applies depend on list order, which no
 * merchant intends and none would notice until a shopper was quoted the
 * wrong fee.
 */
const assertValid = async (
  merchantId: string,
  input: RegionalPolicyInput,
  exceptId?: string,
) => {
  if (!OUTCOME_KEYS.some((key) => input.outcomes[key].enabled)) {
    throw unprocessable("Turn on at least one return outcome.");
  }

  const others = await prisma.regionalPolicy.findMany({
    where: { merchantId, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { name: true, countries: true },
  });
  for (const country of input.countries) {
    const taken = others.find((p) => p.countries.includes(country));
    if (taken) {
      throw unprocessable(
        `${countryName(country)} is already covered by "${taken.name}". Remove it there first.`,
      );
    }
  }

  if (input.destinationId) {
    const destination = await prisma.returnDestination.findFirst({
      where: { id: input.destinationId, merchantId },
      select: { id: true },
    });
    if (!destination) {
      throw unprocessable("That destination no longer exists. Choose another.");
    }
  }
};

const outcomeRows = (outcomes: RegionalPolicyInput["outcomes"]) =>
  OUTCOME_KEYS.map((key) => {
    const o = outcomes[key];
    return {
      resolution: key,
      enabled: o.enabled,
      windowDays: o.windowDays,
      feeType: o.fee?.type ?? null,
      feeValue: o.fee ? new Prisma.Decimal(o.fee.value) : null,
    };
  });

const scalars = (input: RegionalPolicyInput) => ({
  name: input.name,
  countries: input.countries,
  destinationId: input.destinationId,
  inventoryLocationIds: input.inventoryLocationIds,
  allowInstantExchange: input.allowInstantExchange,
  allowAdvancedExchange: input.allowAdvancedExchange,
  exchangeShippingMethod: input.exchangeShippingMethod,
  windowStartsFrom: input.windowStartsFrom,
  bypassReview: input.bypassReview,
  instructions: input.instructions,
});

export const createRegionalPolicy = async (
  merchantId: string,
  input: RegionalPolicyInput,
) => {
  await assertValid(merchantId, input);
  const last = await prisma.regionalPolicy.aggregate({
    where: { merchantId },
    _max: { sortOrder: true },
  });
  return prisma.regionalPolicy.create({
    data: {
      merchantId,
      ...scalars(input),
      sortOrder: (last._max.sortOrder ?? -1) + 1,
      outcomes: { create: outcomeRows(input.outcomes) },
    },
    include,
  });
};

export const updateRegionalPolicy = async (
  merchantId: string,
  id: string,
  input: RegionalPolicyInput,
) => {
  const existing = await prisma.regionalPolicy.findFirst({
    where: { id, merchantId },
    select: { id: true },
  });
  if (!existing) throw notFound("Policy not found.");
  await assertValid(merchantId, input, id);

  // Outcomes are rewritten whole: four rows, always the same four keys.
  return prisma.$transaction(async (tx) => {
    await tx.regionalPolicyOutcome.deleteMany({ where: { policyId: id } });
    return tx.regionalPolicy.update({
      where: { id },
      data: {
        ...scalars(input),
        outcomes: { create: outcomeRows(input.outcomes) },
      },
      include,
    });
  });
};

export const deleteRegionalPolicy = async (merchantId: string, id: string) => {
  const { count } = await prisma.regionalPolicy.deleteMany({
    where: { id, merchantId },
  });
  if (count === 0) throw notFound("Policy not found.");
};

export const reorderRegionalPolicies = async (
  merchantId: string,
  ids: string[],
) => {
  const owned = await prisma.regionalPolicy.findMany({
    where: { merchantId },
    select: { id: true },
  });
  const known = new Set(owned.map((p) => p.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw unprocessable("The list of policies is out of date. Reload and try again.");
  }
  await prisma.$transaction(
    ids.map((id, sortOrder) =>
      prisma.regionalPolicy.update({ where: { id }, data: { sortOrder } }),
    ),
  );
};
