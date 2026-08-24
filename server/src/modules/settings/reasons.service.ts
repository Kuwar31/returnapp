import { badRequest, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/prisma.js";
import { SHOPIFY_RETURN_REASONS } from "../shopify/returns.graphql.js";

/** Reasons come back as a tree; only leaves are selectable in the portal. */
const reasonInclude = {
  children: { where: { active: true }, orderBy: { sortOrder: "asc" as const } },
} as const;

export const listGroups = async (merchantId: string) =>
  prisma.returnReasonGroup.findMany({
    where: { merchantId },
    orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }],
    include: {
      reasons: {
        where: { parentId: null },
        // Retired reasons sink to the bottom. They have to stay visible —
        // past returns point at them — but interleaved with the live ones
        // they read as gaps in the list the merchant is actually editing.
        orderBy: [{ active: "desc" }, { sortOrder: "asc" }],
        include: {
          children: { orderBy: [{ active: "desc" }, { sortOrder: "asc" }] },
        },
      },
    },
  });

/**
 * Picks the group whose product types claim this line, falling back to the
 * default.
 *
 * Matching is case-insensitive and trimmed because product types are free text
 * in Shopify — "Snowboards", "snowboards " and "Snowboard" are all things a
 * merchant will actually type into the settings box.
 */
export const resolveGroupForProductType = async (
  merchantId: string,
  productType: string | null,
) => {
  const groups = await prisma.returnReasonGroup.findMany({
    where: { merchantId },
    orderBy: [{ sortOrder: "asc" }],
  });
  if (groups.length === 0) return null;

  const needle = productType?.trim().toLowerCase();
  const matched = needle
    ? groups.find((g) =>
        g.productTypes.some((t) => t.trim().toLowerCase() === needle),
      )
    : undefined;

  return matched ?? groups.find((g) => g.isDefault) ?? groups[0];
};

/**
 * The reason tree a shopper sees for one group.
 *
 * Inactive reasons are dropped here rather than in the query so a parent whose
 * children were all switched off still disappears — offering a category that
 * leads nowhere is worse than not offering it.
 */
export const getReasonTree = async (groupId: string, randomize: boolean) => {
  const parents = await prisma.returnReason.findMany({
    where: { groupId, parentId: null, active: true },
    orderBy: { sortOrder: "asc" },
    include: reasonInclude,
  });

  const usable = parents.filter(
    (p) => p.children.length > 0 || p.code.length > 0,
  );

  // Fisher-Yates on a copy. Shuffling top level only: the sub-reasons under a
  // parent are a considered order the merchant wrote, not a list to scramble.
  if (randomize) {
    for (let i = usable.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [usable[i], usable[j]] = [usable[j], usable[i]];
    }
  }
  return usable;
};

const assertValidCode = (code: string) => {
  if (!SHOPIFY_RETURN_REASONS.has(code)) {
    throw badRequest(
      `"${code}" isn't a reason Shopify accepts. Pick one of: ${[...SHOPIFY_RETURN_REASONS].join(", ")}.`,
    );
  }
};

export const createGroup = (
  merchantId: string,
  input: { title: string; productTypes?: string[]; randomizeOrder?: boolean },
) =>
  prisma.returnReasonGroup.create({
    data: {
      merchantId,
      title: input.title,
      productTypes: input.productTypes ?? [],
      randomizeOrder: input.randomizeOrder ?? false,
    },
  });

export const updateGroup = async (
  merchantId: string,
  id: string,
  input: { title?: string; productTypes?: string[]; randomizeOrder?: boolean },
) => {
  const group = await prisma.returnReasonGroup.findFirst({
    where: { id, merchantId },
  });
  if (!group) throw notFound("Reason group not found.");
  return prisma.returnReasonGroup.update({ where: { id }, data: input });
};

export const deleteGroup = async (merchantId: string, id: string) => {
  const group = await prisma.returnReasonGroup.findFirst({
    where: { id, merchantId },
  });
  if (!group) throw notFound("Reason group not found.");
  // Something has to catch products no group claims, so the fallback stays.
  if (group.isDefault) {
    throw badRequest(
      "The default group can't be deleted — it's what catches every product no other group claims.",
    );
  }
  await prisma.returnReasonGroup.delete({ where: { id } });
};

export const createReason = async (
  merchantId: string,
  input: {
    groupId: string;
    parentId?: string | null;
    code: string;
    label: string;
    requiresNote?: boolean;
    requiresPhoto?: boolean;
  },
) => {
  assertValidCode(input.code);
  const group = await prisma.returnReasonGroup.findFirst({
    where: { id: input.groupId, merchantId },
  });
  if (!group) throw notFound("Reason group not found.");

  if (input.parentId) {
    const parent = await prisma.returnReason.findFirst({
      where: { id: input.parentId, merchantId },
    });
    if (!parent) throw notFound("Parent reason not found.");
    // Two levels is the whole model; a third would give the shopper a tree to
    // navigate rather than a question to answer.
    if (parent.parentId) {
      throw badRequest("Reasons can only nest one level deep.");
    }
  }

  const siblings = await prisma.returnReason.count({
    where: { groupId: input.groupId, parentId: input.parentId ?? null },
  });

  return prisma.returnReason.create({
    data: {
      merchantId,
      groupId: input.groupId,
      parentId: input.parentId ?? null,
      code: input.code,
      label: input.label,
      requiresNote: input.requiresNote ?? false,
      requiresPhoto: input.requiresPhoto ?? false,
      sortOrder: siblings,
    },
  });
};

export const updateReason = async (
  merchantId: string,
  id: string,
  input: {
    code?: string;
    label?: string;
    requiresNote?: boolean;
    requiresPhoto?: boolean;
    active?: boolean;
    sortOrder?: number;
  },
) => {
  if (input.code) assertValidCode(input.code);
  const reason = await prisma.returnReason.findFirst({
    where: { id, merchantId },
  });
  if (!reason) throw notFound("Reason not found.");
  return prisma.returnReason.update({ where: { id }, data: input });
};

/**
 * Retires a reason rather than deleting it once it's been used.
 *
 * Past returns record which reason was picked; hard-deleting one would blank
 * that on every historical line item and quietly corrupt the merchant's own
 * reporting.
 */
export const deleteReason = async (merchantId: string, id: string) => {
  const reason = await prisma.returnReason.findFirst({
    where: { id, merchantId },
    include: { _count: { select: { returnLineItems: true } } },
  });
  if (!reason) throw notFound("Reason not found.");

  if (reason._count.returnLineItems > 0) {
    await prisma.returnReason.update({ where: { id }, data: { active: false } });
    return { retired: true };
  }
  await prisma.returnReason.delete({ where: { id } });
  return { retired: false };
};
