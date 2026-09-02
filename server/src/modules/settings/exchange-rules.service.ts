import type { BonusType, ExchangeRuleMatch } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { resolveExchangeBonus } from "./merchant-settings.js";

/**
 * "Advanced exchanges": which lists a returned item may be swapped into.
 *
 * A rule names the items it applies to — by tag, or by a fragment of the
 * product title — and carries one or more options, each backed by a Shopify
 * collection. A shopper returning a matching item is offered those lists
 * instead of the whole catalogue.
 */

const ruleInclude = {
  options: { orderBy: { sortOrder: "asc" as const } },
};

export const listRules = (merchantId: string) =>
  prisma.exchangeRule.findMany({
    where: { merchantId },
    include: ruleInclude,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

export const getRule = async (merchantId: string, id: string) => {
  const rule = await prisma.exchangeRule.findFirst({
    where: { id, merchantId },
    include: ruleInclude,
  });
  if (!rule) throw notFound("That exchange rule doesn't exist.");
  return rule;
};

export interface RuleInput {
  name: string;
  active?: boolean;
  matchBy?: ExchangeRuleMatch;
  matchValues?: string[];
  showProductTitles?: boolean;
  bonusType?: BonusType;
  /** Null clears the override, falling back to the store-wide bonus. */
  bonusValue?: number | null;
  options?: Array<{ label: string; collectionId: string; collectionTitle: string }>;
}

export const createRule = async (merchantId: string, input: RuleInput) => {
  const count = await prisma.exchangeRule.count({ where: { merchantId } });
  const rule = await prisma.exchangeRule.create({
    data: {
      merchantId,
      name: input.name,
      active: input.active ?? true,
      // New rules land at the bottom, so their options appear after the ones
      // already configured rather than jumping the queue.
      sortOrder: count,
      matchBy: input.matchBy ?? "PRODUCT_TAG",
      matchValues: input.matchValues ?? [],
      showProductTitles: input.showProductTitles ?? false,
      bonusType: input.bonusType ?? null,
      bonusValue: input.bonusValue ?? null,
      options: {
        create: (input.options ?? []).map((o, i) => ({ ...o, sortOrder: i })),
      },
    },
    include: ruleInclude,
  });
  return rule;
};

export const updateRule = async (
  merchantId: string,
  id: string,
  input: RuleInput,
) => {
  await getRule(merchantId, id);

  /**
   * Options are replaced wholesale rather than diffed.
   *
   * They carry no state worth preserving — a label, a collection and a
   * position — and the editor sends the whole list every time, so matching
   * them up by id would be ceremony around the same outcome.
   */
  return prisma.$transaction(async (tx) => {
    if (input.options) {
      await tx.exchangeRuleOption.deleteMany({ where: { ruleId: id } });
    }
    return tx.exchangeRule.update({
      where: { id },
      data: {
        name: input.name,
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.matchBy ? { matchBy: input.matchBy } : {}),
        ...(input.matchValues ? { matchValues: input.matchValues } : {}),
        ...(input.showProductTitles === undefined
          ? {}
          : { showProductTitles: input.showProductTitles }),
        ...(input.bonusType === undefined ? {} : { bonusType: input.bonusType }),
        ...(input.bonusValue === undefined
          ? {}
          : { bonusValue: input.bonusValue }),
        ...(input.options
          ? {
              options: {
                create: input.options.map((o, i) => ({ ...o, sortOrder: i })),
              },
            }
          : {}),
      },
      include: ruleInclude,
    });
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

/**
 * Every rule that governs one returned item.
 *
 * All matches contribute, in the merchant's own order, rather than the first
 * one winning outright. Two rules that both match used to leave the second
 * silently doing nothing — with no sign of it anywhere in the admin — and a
 * rule that quietly never fires is worse than one that fires too often. The
 * ordering now decides what the shopper sees first; exclusivity is expressed
 * by writing rules that don't overlap.
 *
 * Matching runs against the snapshot taken when the order synced — the tags
 * and title as they were then — because a shopper's options shouldn't change
 * because a product was retagged after they bought it.
 */
export const rulesForLine = async (
  merchantId: string,
  line: { productTags: string[]; title: string },
) => {
  const rules = await prisma.exchangeRule.findMany({
    where: { merchantId, active: true },
    include: ruleInclude,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  const tags = line.productTags.map((t) => t.trim().toLowerCase());
  const title = line.title.toLowerCase();

  return rules.filter((rule) => {
    const values = rule.matchValues
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean);
    // A rule with nothing to match on, or nothing to offer, would only ever
    // produce an empty menu.
    if (values.length === 0 || rule.options.length === 0) return false;
    return rule.matchBy === "PRODUCT_TAG"
      ? values.some((v) => tags.includes(v))
      : values.some((v) => title.includes(v));
  });
};

/**
 * The bonus that governs an exchange, when a rule sets one.
 *
 * The rule that matched the *returned* item decides, not the collection the
 * shopper picked from — a merchant offering "10% extra on footwear swaps" is
 * describing what came back, and resolving it the other way would need the
 * server to work out which collection every chosen product belongs to on every
 * quote.
 *
 * Where several rules match, the first that sets one wins by the merchant's
 * own ordering. Returns undefined when no matching rule overrides, which is
 * the signal to fall back to the store-wide setting.
 */
export const ruleBonusForLines = async (
  merchantId: string,
  lines: Array<{ productTags: string[]; title: string }>,
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
 * A rule that matched one of the returned items overrides the store-wide
 * setting; that in turn falls back to the policy's percentage. Resolved in one
 * place because the portal's quote, the draft order's price and the admin's
 * recomputations all have to reach the same answer — and it lives here rather
 * than in the portal so the two callers above it don't have to import
 * downwards through it.
 */
export const exchangeBonusFor = async (
  merchantId: string,
  lines: Array<{ productTags: string[]; title: string }>,
) =>
  (await ruleBonusForLines(merchantId, lines)) ??
  (await resolveExchangeBonus(merchantId));
