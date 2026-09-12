import { badRequest, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { SHOPIFY_RETURN_REASONS } from "../shopify/returns.graphql.js";

/**
 * Return reasons, laid out as AfterShip's: a library of reasons, each with
 * its sub-reasons, and reason groups that pick from the library by
 * conditions on the product being returned.
 *
 * Groups are checked in order and the first whose conditions the product
 * meets applies; the default group, which has none, catches the rest.
 */

export interface SubReasonInput {
  /** Set for an existing sub-reason; absent for one being added. */
  id?: string | null;
  label: string;
  code: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
}

export interface ReasonInput {
  label: string;
  code: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
  /** The whole set: anything missing is removed. */
  children?: SubReasonInput[];
}

export interface GroupInput {
  title?: string;
  productTypes?: string[];
  productTags?: string[];
  randomizeOrder?: boolean;
  /** Top-level library reasons, in the order the shopper sees them. */
  reasonIds?: string[];
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------

const libraryInclude = {
  children: { where: { active: true }, orderBy: { sortOrder: "asc" as const } },
  _count: { select: { groups: true } },
} as const;

/** Every live top-level reason with its live sub-reasons. */
export const listLibrary = (merchantId: string) =>
  prisma.returnReason.findMany({
    where: { merchantId, parentId: null, active: true },
    orderBy: [{ sortOrder: "asc" }, { label: "asc" }],
    include: libraryInclude,
  });

type LibraryRow = Awaited<ReturnType<typeof listLibrary>>[number];

export const serializeReason = (r: LibraryRow) => ({
  id: r.id,
  label: r.label,
  code: r.code,
  requiresNote: r.requiresNote,
  requiresPhoto: r.requiresPhoto,
  /** How many groups offer it, so the library can say where it's used. */
  groupCount: r._count.groups,
  children: r.children.map((c) => ({
    id: c.id,
    label: c.label,
    code: c.code,
    requiresNote: c.requiresNote,
    requiresPhoto: c.requiresPhoto,
  })),
});

const assertValidCode = (code: string) => {
  if (!SHOPIFY_RETURN_REASONS.has(code)) {
    throw badRequest(
      `"${code}" isn't a reason Shopify accepts. Pick one of: ${[...SHOPIFY_RETURN_REASONS].join(", ")}.`,
    );
  }
};

const flags = (input: { requiresNote?: boolean; requiresPhoto?: boolean }) => ({
  requiresNote: input.requiresNote ?? false,
  requiresPhoto: input.requiresPhoto ?? false,
});

const getReason = async (merchantId: string, id: string) => {
  const reason = await prisma.returnReason.findFirst({
    where: { id, merchantId, parentId: null },
    include: libraryInclude,
  });
  if (!reason) throw notFound("Reason not found.");
  return reason;
};

export const createReason = async (merchantId: string, input: ReasonInput) => {
  assertValidCode(input.code);
  for (const child of input.children ?? []) assertValidCode(child.code);

  const last = await prisma.returnReason.aggregate({
    where: { merchantId, parentId: null },
    _max: { sortOrder: true },
  });
  const created = await prisma.$transaction(async (tx) => {
    const parent = await tx.returnReason.create({
      data: {
        merchantId,
        code: input.code,
        label: input.label,
        ...flags(input),
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
    });
    if (input.children?.length) {
      await tx.returnReason.createMany({
        data: input.children.map((child, sortOrder) => ({
          merchantId,
          parentId: parent.id,
          code: child.code,
          label: child.label,
          ...flags(child),
          sortOrder,
        })),
      });
    }
    return parent;
  });
  return getReason(merchantId, created.id);
};

/**
 * Replaces a reason and its whole set of sub-reasons.
 *
 * A sub-reason that past returns point at is retired rather than deleted
 * when it's dropped, so history keeps its label; the rest simply go.
 */
export const updateReason = async (merchantId: string, id: string, input: ReasonInput) => {
  assertValidCode(input.code);
  const wanted = input.children ?? [];
  for (const child of wanted) assertValidCode(child.code);

  const reason = await prisma.returnReason.findFirst({
    where: { id, merchantId, parentId: null },
    include: {
      children: { include: { _count: { select: { returnLineItems: true } } } },
    },
  });
  if (!reason) throw notFound("Reason not found.");

  const known = new Set(reason.children.map((c) => c.id));
  for (const child of wanted) {
    if (child.id && !known.has(child.id)) throw notFound("Sub-reason not found.");
  }
  const kept = new Set(wanted.flatMap((c) => (c.id ? [c.id] : [])));

  await prisma.$transaction(async (tx) => {
    await tx.returnReason.update({
      where: { id },
      data: { label: input.label, code: input.code, ...flags(input) },
    });
    for (const [sortOrder, child] of wanted.entries()) {
      const data = { label: child.label, code: child.code, ...flags(child), sortOrder };
      if (child.id) {
        await tx.returnReason.update({ where: { id: child.id }, data: { ...data, active: true } });
      } else {
        await tx.returnReason.create({ data: { merchantId, parentId: id, ...data } });
      }
    }
    for (const child of reason.children) {
      if (kept.has(child.id)) continue;
      if (child._count.returnLineItems > 0) {
        await tx.returnReason.update({ where: { id: child.id }, data: { active: false } });
      } else {
        await tx.returnReason.delete({ where: { id: child.id } });
      }
    }
  });
  return getReason(merchantId, id);
};

/**
 * Removes a reason from the library and from every group.
 *
 * Retired rather than deleted once it — or one of its sub-reasons — has been
 * picked on a return: past returns record which reason was chosen, and
 * hard-deleting it would blank that on every historical line item.
 */
export const deleteReason = async (merchantId: string, id: string) => {
  const reason = await prisma.returnReason.findFirst({
    where: { id, merchantId, parentId: null },
    include: {
      _count: { select: { returnLineItems: true } },
      children: { select: { _count: { select: { returnLineItems: true } } } },
    },
  });
  if (!reason) throw notFound("Reason not found.");

  const used =
    reason._count.returnLineItems > 0 ||
    reason.children.some((c) => c._count.returnLineItems > 0);
  if (used) {
    await prisma.$transaction([
      prisma.returnReasonGroupEntry.deleteMany({ where: { reasonId: id } }),
      prisma.returnReason.updateMany({
        where: { OR: [{ id }, { parentId: id }] },
        data: { active: false },
      }),
    ]);
    return { retired: true };
  }
  // Sub-reasons and group entries go with it.
  await prisma.returnReason.delete({ where: { id } });
  return { retired: false };
};

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

const groupInclude = {
  entries: {
    orderBy: { sortOrder: "asc" as const },
    include: { reason: { select: { active: true } } },
  },
} as const;

/** Every group in the order they're checked, the default last. */
export const listGroups = (merchantId: string) =>
  prisma.returnReasonGroup.findMany({
    where: { merchantId },
    orderBy: [{ isDefault: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
    include: groupInclude,
  });

type GroupRow = Awaited<ReturnType<typeof listGroups>>[number];

export const serializeGroup = (g: GroupRow) => ({
  id: g.id,
  title: g.title,
  productTypes: g.productTypes,
  productTags: g.productTags,
  randomizeOrder: g.randomizeOrder,
  isDefault: g.isDefault,
  reasonIds: g.entries.filter((e) => e.reason.active).map((e) => e.reasonId),
});

const lower = (values: string[]) =>
  new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));

/** A product as a group sees it. */
export interface ProductFacts {
  productType: string | null;
  productTags: string[];
}

/**
 * Whether a group claims a product. Pure.
 *
 * Matching is case-insensitive and trimmed because types and tags are free
 * text in Shopify — "Snowboards", "snowboards " and "Snowboard" are all
 * things a merchant will actually type into the box. A group with no
 * conditions claims nothing: the default is the one that catches the rest.
 */
export const groupClaims = (
  group: { productTypes: string[]; productTags: string[] },
  product: ProductFacts,
): boolean => {
  const types = lower(group.productTypes);
  const tags = lower(group.productTags);
  if (types.size === 0 && tags.size === 0) return false;
  if (types.size > 0) {
    const type = product.productType?.trim().toLowerCase();
    if (!type || !types.has(type)) return false;
  }
  if (tags.size > 0 && !product.productTags.some((t) => tags.has(t.trim().toLowerCase()))) {
    return false;
  }
  return true;
};

/** The groups as the portal checks them: in order, the default last. */
export const groupsForMatching = (merchantId: string) =>
  prisma.returnReasonGroup.findMany({
    where: { merchantId },
    orderBy: [{ isDefault: "asc" }, { sortOrder: "asc" }, { createdAt: "asc" }],
  });

type MatchableGroup = Awaited<ReturnType<typeof groupsForMatching>>[number];

/** The first group that claims the product, else the default. Pure. */
export const pickGroup = (
  groups: MatchableGroup[],
  product: ProductFacts,
): MatchableGroup | null => {
  if (groups.length === 0) return null;
  return (
    groups.find((g) => !g.isDefault && groupClaims(g, product)) ??
    groups.find((g) => g.isDefault) ??
    groups[0]
  );
};

/**
 * What a sub-reason asks of the shopper is at least what its parent asks:
 * "Item was damaged" wanting a photo means every way of being damaged does.
 */
export const requirementsOf = (
  reason: { requiresNote: boolean; requiresPhoto: boolean },
  parent: { requiresNote: boolean; requiresPhoto: boolean } | null,
) => ({
  requiresNote: reason.requiresNote || (parent?.requiresNote ?? false),
  requiresPhoto: reason.requiresPhoto || (parent?.requiresPhoto ?? false),
});

/**
 * The reason tree a shopper sees for one group.
 *
 * Retired reasons and sub-reasons are left out, so a parent whose children
 * were all retired offers itself rather than a category leading nowhere.
 */
export const getReasonTree = async (groupId: string, randomize: boolean) => {
  const entries = await prisma.returnReasonGroupEntry.findMany({
    where: { groupId, reason: { active: true, parentId: null } },
    orderBy: { sortOrder: "asc" },
    include: {
      reason: {
        include: {
          children: { where: { active: true }, orderBy: { sortOrder: "asc" as const } },
        },
      },
    },
  });

  const tree = entries.map(({ reason }) => ({
    ...reason,
    children: reason.children.map((child) => ({ ...child, ...requirementsOf(child, reason) })),
  }));

  // Fisher-Yates on a copy. Shuffling top level only: the sub-reasons under a
  // parent are a considered order the merchant wrote, not a list to scramble.
  if (randomize) {
    for (let i = tree.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tree[i], tree[j]] = [tree[j], tree[i]];
    }
  }
  return tree;
};

const cleanList = (values: string[] | undefined) =>
  values === undefined ? undefined : [...new Set(values.map((v) => v.trim()).filter(Boolean))];

/** A group offers only the store's own live, top-level reasons. */
const assertReasonsOwned = async (merchantId: string, reasonIds: string[]) => {
  if (reasonIds.length === 0) return;
  const owned = await prisma.returnReason.count({
    where: { merchantId, parentId: null, active: true, id: { in: reasonIds } },
  });
  if (owned !== reasonIds.length) throw notFound("One of those reasons isn't in your library.");
};

const entryRows = (reasonIds: string[]) =>
  reasonIds.map((reasonId, sortOrder) => ({ reasonId, sortOrder }));

export const createGroup = async (
  merchantId: string,
  input: GroupInput & { title: string },
) => {
  const reasonIds = [...new Set(input.reasonIds ?? [])];
  await assertReasonsOwned(merchantId, reasonIds);
  const last = await prisma.returnReasonGroup.aggregate({
    where: { merchantId, isDefault: false },
    _max: { sortOrder: true },
  });
  return prisma.returnReasonGroup.create({
    data: {
      merchantId,
      title: input.title,
      productTypes: cleanList(input.productTypes) ?? [],
      productTags: cleanList(input.productTags) ?? [],
      randomizeOrder: input.randomizeOrder ?? false,
      sortOrder: (last._max.sortOrder ?? -1) + 1,
      entries: { create: entryRows(reasonIds) },
    },
    include: groupInclude,
  });
};

export const updateGroup = async (merchantId: string, id: string, input: GroupInput) => {
  const group = await prisma.returnReasonGroup.findFirst({ where: { id, merchantId } });
  if (!group) throw notFound("Reason group not found.");
  const reasonIds = input.reasonIds === undefined ? undefined : [...new Set(input.reasonIds)];
  if (reasonIds) await assertReasonsOwned(merchantId, reasonIds);

  return prisma.$transaction(async (tx) => {
    if (reasonIds) await tx.returnReasonGroupEntry.deleteMany({ where: { groupId: id } });
    return tx.returnReasonGroup.update({
      where: { id },
      data: {
        title: input.title,
        // The default claims whatever is left; it has no conditions to keep.
        productTypes: group.isDefault ? [] : cleanList(input.productTypes),
        productTags: group.isDefault ? [] : cleanList(input.productTags),
        randomizeOrder: input.randomizeOrder,
        ...(reasonIds ? { entries: { create: entryRows(reasonIds) } } : {}),
      },
      include: groupInclude,
    });
  });
};

export const deleteGroup = async (merchantId: string, id: string) => {
  const group = await prisma.returnReasonGroup.findFirst({ where: { id, merchantId } });
  if (!group) throw notFound("Reason group not found.");
  // Something has to catch products no group claims, so the fallback stays.
  if (group.isDefault) {
    throw badRequest(
      "The default group can't be deleted — it's what catches every product no other group claims.",
    );
  }
  await prisma.returnReasonGroup.delete({ where: { id } });
};
