import type {
  BonusType,
  ExchangeOfferMatch,
  ExchangePricing,
  ExchangeRule,
  ExchangeRuleMatch,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { productCollections } from "../shopify/catalogue.service.js";
import { resolveExchangeBonus } from "./merchant-settings.js";

/**
 * Exchange groups — "advanced exchanges".
 *
 * A group pairs the items it applies to with the products they may become: a
 * *return condition* on the item coming back (tag, type, a fragment of the
 * title, or a collection) and an *offer condition* on what is shown in its
 * place (tag, type or collection). Its name is what the shopper reads on the
 * option card. A returned item that matches several groups is offered all of
 * them, in the merchant's order.
 */

const ordering = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }];

export const listRules = (merchantId: string) =>
  prisma.exchangeRule.findMany({ where: { merchantId }, orderBy: ordering });

export const getRule = async (merchantId: string, id: string) => {
  const rule = await prisma.exchangeRule.findFirst({ where: { id, merchantId } });
  if (!rule) throw notFound("That exchange group doesn't exist.");
  return rule;
};

export interface RuleInput {
  name: string;
  active?: boolean;
  matchBy?: ExchangeRuleMatch;
  matchValues?: string[];
  offerBy?: ExchangeOfferMatch;
  offerValues?: string[];
  pricing?: ExchangePricing;
  inStockOnly?: boolean;
  allowNote?: boolean;
  showProductTitles?: boolean;
  bonusType?: BonusType;
  /** Null clears the override, falling back to the store-wide bonus. */
  bonusValue?: number | null;
}

/** Trimmed, de-duplicated, empties dropped. */
const cleanValues = (values: string[] | undefined) =>
  values === undefined
    ? undefined
    : [...new Set(values.map((v) => v.trim()).filter(Boolean))];

export const createRule = async (merchantId: string, input: RuleInput) => {
  const count = await prisma.exchangeRule.count({ where: { merchantId } });
  return prisma.exchangeRule.create({
    data: {
      merchantId,
      name: input.name,
      active: input.active ?? true,
      // New groups land at the bottom, so they appear after the ones already
      // configured rather than jumping the queue.
      sortOrder: count,
      matchBy: input.matchBy ?? "PRODUCT_TAG",
      matchValues: cleanValues(input.matchValues) ?? [],
      offerBy: input.offerBy ?? "COLLECTION",
      offerValues: cleanValues(input.offerValues) ?? [],
      pricing: input.pricing ?? "DIFFERENCE",
      inStockOnly: input.inStockOnly ?? true,
      allowNote: input.allowNote ?? false,
      showProductTitles: input.showProductTitles ?? false,
      bonusType: input.bonusType ?? null,
      bonusValue: input.bonusValue ?? null,
    },
  });
};

export const updateRule = async (
  merchantId: string,
  id: string,
  input: RuleInput,
) => {
  await getRule(merchantId, id);
  const matchValues = cleanValues(input.matchValues);
  const offerValues = cleanValues(input.offerValues);
  return prisma.exchangeRule.update({
    where: { id },
    data: {
      name: input.name,
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.matchBy ? { matchBy: input.matchBy } : {}),
      ...(matchValues ? { matchValues } : {}),
      ...(input.offerBy ? { offerBy: input.offerBy } : {}),
      ...(offerValues ? { offerValues } : {}),
      ...(input.pricing ? { pricing: input.pricing } : {}),
      ...(input.inStockOnly === undefined ? {} : { inStockOnly: input.inStockOnly }),
      ...(input.allowNote === undefined ? {} : { allowNote: input.allowNote }),
      ...(input.showProductTitles === undefined
        ? {}
        : { showProductTitles: input.showProductTitles }),
      ...(input.bonusType === undefined ? {} : { bonusType: input.bonusType }),
      ...(input.bonusValue === undefined ? {} : { bonusValue: input.bonusValue }),
    },
  });
};

export const deleteRule = async (merchantId: string, id: string) => {
  await getRule(merchantId, id);
  await prisma.exchangeRule.delete({ where: { id } });
};

/** Reorders the whole set, since order is only meaningful across all of them. */
export const reorderRules = async (merchantId: string, ids: string[]) => {
  const owned = await prisma.exchangeRule.findMany({
    where: { merchantId, id: { in: ids } },
    select: { id: true },
  });
  const mine = new Set(owned.map((r) => r.id));
  await prisma.$transaction(
    ids
      .filter((id) => mine.has(id))
      .map((id, index) =>
        prisma.exchangeRule.update({
          where: { id },
          data: { sortOrder: index },
        }),
      ),
  );
};

/** What a returned item is judged on. The snapshot taken when the order synced. */
export interface LineFacts {
  productTags: string[];
  title: string;
  productType?: string | null;
  productId?: string | null;
}

const norm = (value: string) => value.trim().toLowerCase();

/** Whether a returned item satisfies a group's return condition. */
const lineMatches = (
  rule: ExchangeRule,
  line: LineFacts,
  collectionIds: string[],
): boolean => {
  const values = rule.matchValues.map(norm).filter(Boolean);
  // A group with nothing to match on, or nothing to offer, would only ever
  // produce an empty menu.
  if (values.length === 0 || rule.offerValues.length === 0) return false;
  switch (rule.matchBy) {
    case "PRODUCT_TAG":
      return line.productTags.some((t) => values.includes(norm(t)));
    case "PRODUCT_NAME": {
      const title = line.title.toLowerCase();
      return values.some((v) => title.includes(v));
    }
    case "PRODUCT_TYPE":
      return line.productType ? values.includes(norm(line.productType)) : false;
    case "COLLECTION":
      return collectionIds.some((id) => rule.matchValues.includes(id));
  }
};

/**
 * Every group that governs one returned item.
 *
 * All matches contribute, in the merchant's own order, rather than the first
 * one winning outright: a group that quietly never fires is worse than one
 * that fires too often, and exclusivity is expressed by writing groups that
 * don't overlap.
 *
 * Tags, type and title come from the snapshot taken when the order synced,
 * because a shopper's options shouldn't change because a product was retagged
 * after they bought it. Collections aren't on that snapshot — membership is
 * not a property of the line — so they are read from Shopify, and only when a
 * group actually asks by collection. Unreadable means no match, never a guess.
 */
export const rulesForLine = async (merchantId: string, line: LineFacts) => {
  const rules = await prisma.exchangeRule.findMany({
    where: { merchantId, active: true },
    orderBy: ordering,
  });
  if (rules.length === 0) return [];

  const needsCollections = rules.some((r) => r.matchBy === "COLLECTION");
  const collectionIds =
    needsCollections && line.productId
      ? await productCollections(merchantId, line.productId)
      : [];

  return rules.filter((rule) => lineMatches(rule, line, collectionIds));
};

/** Whether a catalogue product satisfies a group's offer condition. */
export const productMatchesOffer = (
  rule: Pick<ExchangeRule, "offerBy" | "offerValues">,
  product: { tags: string[]; productType: string | null; collectionIds: string[] },
): boolean => {
  const values = rule.offerValues.map(norm).filter(Boolean);
  if (values.length === 0) return false;
  switch (rule.offerBy) {
    case "PRODUCT_TAG":
      return product.tags.some((t) => values.includes(norm(t)));
    case "PRODUCT_TYPE":
      return product.productType
        ? values.includes(norm(product.productType))
        : false;
    case "COLLECTION":
      return product.collectionIds.some((id) => rule.offerValues.includes(id));
  }
};

/**
 * A group's offer condition as a Shopify product-search clause.
 *
 * Values are quoted, with quote marks and backslashes removed rather than
 * escaped: Shopify's search syntax has no dependable escape inside a phrase,
 * and a tag containing a quote is not something worth failing a browse over.
 */
const phrase = (value: string) => `"${value.replace(/["\\]/g, "").trim()}"`;

export const offerQuery = (
  rule: Pick<ExchangeRule, "offerBy" | "offerValues">,
): string => {
  const clauses = rule.offerValues
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) =>
      rule.offerBy === "COLLECTION"
        ? // Shopify's product search takes the numeric id, not the GID.
          `collection_id:${v.split("/").pop()}`
        : rule.offerBy === "PRODUCT_TAG"
          ? `tag:${phrase(v)}`
          : `product_type:${phrase(v)}`,
    );
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
};

/**
 * The bonus that governs an exchange, when a group sets one.
 *
 * The group that matched the *returned* item decides, not the product the
 * shopper picked — a merchant offering "10% extra on footwear swaps" is
 * describing what came back. Where several groups match, the first that sets
 * one wins by the merchant's own ordering. Returns undefined when none does,
 * which is the signal to fall back to the store-wide setting.
 */
export const ruleBonusForLines = async (
  merchantId: string,
  lines: LineFacts[],
): Promise<{ type: BonusType; value: Prisma.Decimal } | undefined> => {
  for (const line of lines) {
    const matches = await rulesForLine(merchantId, line);
    const withBonus = matches.find(
      (r) => r.bonusValue !== null && r.bonusType !== null,
    );
    if (withBonus) {
      return { type: withBonus.bonusType!, value: withBonus.bonusValue! };
    }
  }
  return undefined;
};

/**
 * Which exchange sweetener applies to a return.
 *
 * A group that matched one of the returned items overrides the store-wide
 * setting; that in turn falls back to the policy's percentage. Resolved in one
 * place because the portal's quote, the draft order's price and the admin's
 * recomputations all have to reach the same answer — and it lives here rather
 * than in the portal so the two callers above it don't have to import
 * downwards through it.
 */
export const exchangeBonusFor = async (merchantId: string, lines: LineFacts[]) =>
  (await ruleBonusForLines(merchantId, lines)) ??
  (await resolveExchangeBonus(merchantId));
