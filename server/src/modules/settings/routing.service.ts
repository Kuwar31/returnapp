import {
  Prisma,
  type ReturnCostMode,
  type ReturnMethodKind,
  type ReturnRoutingMethod,
  type ReturnRoutingRule,
} from "@prisma/client";
import { notFound, unprocessable } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { round2, toDecimal, ZERO } from "../../lib/money.js";
import type { OutcomeKey } from "../policy/effective.js";
import { outcomeKey } from "../policy/effective.js";

/**
 * Return routing rules — which ways of sending items back a shopper is
 * offered, decided by conditions on the return. AfterShip's shape.
 *
 * Rules are checked top to bottom; the first whose every condition matches
 * applies, and the store's default rule, which has none, catches the rest.
 * A store that never opens the page has the default rule alone, offering
 * "ship with any carrier", which is what every return did before this
 * existed.
 */

export const METHOD_KINDS: ReturnMethodKind[] = ["LABEL", "CARRIER", "STORE", "KEEP"];

/** What each method says about itself until the merchant writes their own. */
export const METHOD_DEFAULTS: Record<
  ReturnMethodKind,
  { name: string; description: string }
> = {
  LABEL: {
    name: "Ship with a return label",
    description: "You'll get a return label after your request is approved.",
  },
  CARRIER: {
    name: "Ship with any carrier of your choice",
    description: "You'll get the shipping instructions after your request is approved.",
  },
  STORE: {
    name: "Return to a retail store",
    description: "Return items to our retail store near you.",
  },
  KEEP: {
    name: "Green returns",
    description: "You can keep the items without shipping them back.",
  },
};

/**
 * The conditions a rule checks. Every one present — and non-empty — must
 * match; a rule with none matches everything, which is what the default is.
 */
export interface RoutingConditions {
  /** Regional policy ids, or "DEFAULT" for orders no regional policy claims. */
  policies?: string[];
  /** ISO 3166-1 alpha-2 shipping countries. */
  countries?: string[];
  /** Any returned item carries one of these tags. */
  productTags?: string[];
  /** Any returned item is one of these product types. */
  productTypes?: string[];
  /** Any returned item was given one of these reasons. */
  reasonIds?: string[];
  /** Any returned item takes one of these outcomes. */
  resolutions?: OutcomeKey[];
  /** The value of the items coming back, in shop currency. */
  valueUnder?: number;
  valueAtLeast?: number;
}

/** What a return looks like to a rule. */
export interface RoutingFacts {
  policyKey: string;
  country: string | null;
  lines: Array<{
    productTags: string[];
    productType: string | null;
    reasonId: string | null;
    resolution: string;
  }>;
  itemsSubtotal: Prisma.Decimal;
}

export interface MethodInput {
  enabled: boolean;
  name: string;
  description: string | null;
  costMode: ReturnCostMode;
  costAmount: number | null;
  instructions: string | null;
  autoApprove: boolean;
  storeUrl: string | null;
}

export interface RoutingRuleInput {
  name: string;
  conditions: RoutingConditions;
  methods: Record<ReturnMethodKind, MethodInput>;
}

export type RoutingRuleRow = ReturnRoutingRule & { methods: ReturnRoutingMethod[] };

const include = { methods: true } as const;

const lower = (values: string[] | undefined) =>
  new Set((values ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean));

/** Whether a return satisfies every condition a rule sets. Pure. */
export const matchesConditions = (
  conditions: RoutingConditions,
  facts: RoutingFacts,
): boolean => {
  const c = conditions;
  if (c.policies?.length && !c.policies.includes(facts.policyKey)) return false;
  if (c.countries?.length) {
    if (!facts.country) return false;
    if (!c.countries.map((x) => x.toUpperCase()).includes(facts.country)) return false;
  }
  const tags = lower(c.productTags);
  if (tags.size > 0) {
    const hit = facts.lines.some((l) =>
      l.productTags.some((t) => tags.has(t.trim().toLowerCase())),
    );
    if (!hit) return false;
  }
  const types = lower(c.productTypes);
  if (types.size > 0) {
    const hit = facts.lines.some(
      (l) => l.productType && types.has(l.productType.trim().toLowerCase()),
    );
    if (!hit) return false;
  }
  if (c.reasonIds?.length) {
    const wanted = new Set(c.reasonIds);
    if (!facts.lines.some((l) => l.reasonId && wanted.has(l.reasonId))) return false;
  }
  if (c.resolutions?.length) {
    const wanted = new Set(c.resolutions);
    const hit = facts.lines.some((l) => {
      const key = outcomeKey(l.resolution as never);
      return key !== null && wanted.has(key);
    });
    if (!hit) return false;
  }
  if (c.valueUnder !== undefined && !facts.itemsSubtotal.lessThan(c.valueUnder)) {
    return false;
  }
  if (
    c.valueAtLeast !== undefined &&
    facts.itemsSubtotal.lessThan(c.valueAtLeast)
  ) {
    return false;
  }
  return true;
};

/** The conditions as stored, tolerating a row written by hand. */
export const readConditions = (value: unknown): RoutingConditions =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RoutingConditions)
    : {};

export const serializeMethod = (m: ReturnRoutingMethod) => ({
  enabled: m.enabled,
  name: m.name,
  description: m.description,
  costMode: m.costMode,
  costAmount: m.costAmount === null ? null : Number(m.costAmount),
  instructions: m.instructions,
  autoApprove: m.autoApprove,
  storeUrl: m.storeUrl,
});

export const serializeRule = (row: RoutingRuleRow) => {
  const methods = {} as Record<ReturnMethodKind, ReturnType<typeof serializeMethod>>;
  for (const kind of METHOD_KINDS) {
    const found = row.methods.find((m) => m.kind === kind);
    methods[kind] = found
      ? serializeMethod(found)
      : {
          enabled: false,
          name: METHOD_DEFAULTS[kind].name,
          description: METHOD_DEFAULTS[kind].description,
          costMode: "HIDDEN",
          costAmount: null,
          instructions: null,
          autoApprove: false,
          storeUrl: null,
        };
  }
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault,
    sortOrder: row.sortOrder,
    conditions: readConditions(row.conditions),
    methods,
  };
};

const methodRows = (methods: RoutingRuleInput["methods"]) =>
  METHOD_KINDS.map((kind) => {
    const m = methods[kind];
    return {
      kind,
      enabled: m.enabled,
      name: m.name,
      description: m.description,
      costMode: m.costMode,
      costAmount:
        m.costMode === "FIXED" && m.costAmount !== null
          ? new Prisma.Decimal(m.costAmount)
          : null,
      instructions: m.instructions,
      autoApprove: m.autoApprove,
      storeUrl: kind === "STORE" ? m.storeUrl : null,
    };
  });

/**
 * The store's default rule, made on first sight so the list is never empty
 * and every return has somewhere to route to. "Ship with any carrier" is on,
 * as before routing existed.
 */
export const ensureDefaultRule = async (merchantId: string): Promise<RoutingRuleRow> => {
  const existing = await prisma.returnRoutingRule.findFirst({
    where: { merchantId, isDefault: true },
    include,
  });
  if (existing) return existing;
  return prisma.returnRoutingRule.create({
    data: {
      merchantId,
      name: "Default",
      isDefault: true,
      sortOrder: 1_000_000,
      conditions: {},
      methods: {
        create: METHOD_KINDS.map((kind) => ({
          kind,
          enabled: kind === "CARRIER",
          name: METHOD_DEFAULTS[kind].name,
          description: METHOD_DEFAULTS[kind].description,
        })),
      },
    },
    include,
  });
};

/** Every rule in the order they're checked, the default last. */
export const listRoutingRules = async (merchantId: string): Promise<RoutingRuleRow[]> => {
  await ensureDefaultRule(merchantId);
  return prisma.returnRoutingRule.findMany({
    where: { merchantId },
    orderBy: [{ isDefault: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include,
  });
};

const assertValid = (input: RoutingRuleInput) => {
  if (!METHOD_KINDS.some((kind) => input.methods[kind].enabled)) {
    throw unprocessable("Turn on at least one return method.");
  }
  for (const kind of METHOD_KINDS) {
    const m = input.methods[kind];
    if (m.enabled && m.costMode === "FIXED" && (m.costAmount === null || m.costAmount < 0)) {
      throw unprocessable(`Enter the cost of "${m.name}".`);
    }
  }
};

export const createRoutingRule = async (merchantId: string, input: RoutingRuleInput) => {
  assertValid(input);
  await ensureDefaultRule(merchantId);
  const last = await prisma.returnRoutingRule.aggregate({
    where: { merchantId, isDefault: false },
    _max: { sortOrder: true },
  });
  return prisma.returnRoutingRule.create({
    data: {
      merchantId,
      name: input.name,
      conditions: input.conditions as Prisma.InputJsonObject,
      sortOrder: (last._max.sortOrder ?? -1) + 1,
      methods: { create: methodRows(input.methods) },
    },
    include,
  });
};

export const updateRoutingRule = async (
  merchantId: string,
  id: string,
  input: RoutingRuleInput,
) => {
  const existing = await prisma.returnRoutingRule.findFirst({
    where: { id, merchantId },
    select: { id: true, isDefault: true },
  });
  if (!existing) throw notFound("Routing rule not found.");
  assertValid(input);
  return prisma.$transaction(async (tx) => {
    await tx.returnRoutingMethod.deleteMany({ where: { ruleId: id } });
    return tx.returnRoutingRule.update({
      where: { id },
      data: {
        name: input.name,
        // The default has no conditions to keep, whatever was sent.
        conditions: (existing.isDefault ? {} : input.conditions) as Prisma.InputJsonObject,
        methods: { create: methodRows(input.methods) },
      },
      include,
    });
  });
};

export const deleteRoutingRule = async (merchantId: string, id: string) => {
  const existing = await prisma.returnRoutingRule.findFirst({
    where: { id, merchantId },
    select: { isDefault: true },
  });
  if (!existing) throw notFound("Routing rule not found.");
  if (existing.isDefault) {
    throw unprocessable("The default rule can't be deleted; every return needs a way back.");
  }
  await prisma.returnRoutingRule.delete({ where: { id } });
};

export const reorderRoutingRules = async (merchantId: string, ids: string[]) => {
  const owned = await prisma.returnRoutingRule.findMany({
    where: { merchantId, isDefault: false },
    select: { id: true },
  });
  const known = new Set(owned.map((r) => r.id));
  if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
    throw unprocessable("The list of rules is out of date. Reload and try again.");
  }
  await prisma.$transaction(
    ids.map((id, sortOrder) =>
      prisma.returnRoutingRule.update({ where: { id }, data: { sortOrder } }),
    ),
  );
};

/** A method as the shopper is offered it. */
export interface OfferedMethod {
  kind: ReturnMethodKind;
  name: string;
  description: string | null;
  costMode: ReturnCostMode;
  /** Shop currency; zero unless the mode is FIXED. */
  cost: Prisma.Decimal;
  instructions: string | null;
  autoApprove: boolean;
  storeUrl: string | null;
}

const offered = (m: ReturnRoutingMethod): OfferedMethod => ({
  kind: m.kind,
  name: m.name,
  description: m.description,
  costMode: m.costMode,
  cost:
    m.costMode === "FIXED" && m.costAmount !== null
      ? round2(toDecimal(m.costAmount))
      : ZERO,
  instructions: m.instructions,
  autoApprove: m.autoApprove,
  storeUrl: m.kind === "STORE" ? m.storeUrl : null,
});

/** What the app falls back to with nothing configured at all: ship it yourself. */
const BUILT_IN_CARRIER: OfferedMethod = {
  kind: "CARRIER",
  name: METHOD_DEFAULTS.CARRIER.name,
  description: METHOD_DEFAULTS.CARRIER.description,
  costMode: "HIDDEN",
  cost: ZERO,
  instructions: null,
  autoApprove: false,
  storeUrl: null,
};

/**
 * The rule that applies to a return, and the methods it offers.
 *
 * The first matching rule wins. A matching rule with nothing switched on
 * falls through to the default rather than offering nothing, and a default
 * with nothing on falls back to shipping with any carrier, so the shopper
 * is never left without a way to send things back.
 */
export const routeReturn = async (
  merchantId: string,
  facts: RoutingFacts,
): Promise<{ rule: RoutingRuleRow | null; methods: OfferedMethod[] }> => {
  const rules = await listRoutingRules(merchantId);
  const enabledOf = (rule: RoutingRuleRow) =>
    METHOD_KINDS.flatMap((kind) => {
      const m = rule.methods.find((x) => x.kind === kind);
      return m?.enabled ? [offered(m)] : [];
    });

  const matched = rules.find(
    (rule) => !rule.isDefault && matchesConditions(readConditions(rule.conditions), facts),
  );
  if (matched && enabledOf(matched).length > 0) {
    return { rule: matched, methods: enabledOf(matched) };
  }
  const fallback = rules.find((rule) => rule.isDefault) ?? null;
  const methods = fallback ? enabledOf(fallback) : [];
  return methods.length > 0
    ? { rule: fallback, methods }
    : { rule: null, methods: [BUILT_IN_CARRIER] };
};
