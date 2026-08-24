import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * The reason tree a new store starts with.
 *
 * Two levels, because that's what the portal renders: a category the shopper
 * picks first, then a sub-reason that narrows it. `code` is the mapping onto
 * Shopify's fixed ReturnReason enum and repeats freely — three differently
 * worded children can all report as WRONG_ITEM.
 */
export const DEFAULT_REASON_TREE = [
  {
    code: "SIZE_TOO_SMALL",
    label: "Item didn't fit",
    children: [
      { code: "SIZE_TOO_SMALL", label: "Too small" },
      { code: "SIZE_TOO_LARGE", label: "Too large" },
    ],
  },
  {
    code: "WRONG_ITEM",
    label: "I received the wrong item",
    children: [
      { code: "WRONG_ITEM", label: "Right item, but in the wrong size" },
      { code: "WRONG_ITEM", label: "Right item, but in the wrong style" },
      { code: "WRONG_ITEM", label: "I received the wrong product" },
    ],
  },
  {
    code: "DEFECTIVE",
    label: "Item was damaged",
    requiresPhoto: true,
    children: [
      {
        code: "DEFECTIVE",
        label: "Item was damaged when it arrived",
        requiresPhoto: true,
      },
      {
        code: "DEFECTIVE",
        label: "Item didn't function correctly",
        requiresNote: true,
      },
    ],
  },
  {
    code: "NOT_AS_DESCRIBED",
    label: "Item wasn't as described",
    children: [
      { code: "COLOR", label: "Color not as expected" },
      { code: "NOT_AS_DESCRIBED", label: "Material not as expected" },
      { code: "NOT_AS_DESCRIBED", label: "Looked different in photos" },
    ],
  },
  {
    code: "STYLE",
    label: "I didn't like the item",
    children: [
      { code: "STYLE", label: "Didn't like the style" },
      { code: "STYLE", label: "Didn't like the quality" },
    ],
  },
  { code: "UNWANTED", label: "I found something else I like more", children: [] },
  { code: "OTHER", label: "Other", requiresNote: true, children: [] },
] as Array<{
  code: string;
  label: string;
  requiresNote?: boolean;
  requiresPhoto?: boolean;
  children: Array<{
    code: string;
    label: string;
    requiresNote?: boolean;
    requiresPhoto?: boolean;
  }>;
}>;

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Gives a merchant the default group and its reason tree.
 *
 * Every path that creates a merchant has to call this. The portal resolves
 * reasons through a group, so a store with none — however many loose reasons
 * it has — offers the shopper nothing to pick.
 *
 * Idempotent: a merchant that already has a group is left alone, so this is
 * safe to call on every install rather than only the first.
 */
export const seedDefaultReasonGroup = async (
  db: Db,
  merchantId: string,
): Promise<void> => {
  const existing = await db.returnReasonGroup.count({ where: { merchantId } });
  if (existing > 0) return;

  const group = await db.returnReasonGroup.create({
    data: { merchantId, title: "Default Group", isDefault: true },
  });

  let order = 0;
  for (const parent of DEFAULT_REASON_TREE) {
    const created = await db.returnReason.create({
      data: {
        merchantId,
        groupId: group.id,
        code: parent.code,
        label: parent.label,
        requiresNote: parent.requiresNote ?? false,
        requiresPhoto: parent.requiresPhoto ?? false,
        sortOrder: order++,
      },
    });

    let childOrder = 0;
    for (const child of parent.children) {
      await db.returnReason.create({
        data: {
          merchantId,
          groupId: group.id,
          parentId: created.id,
          code: child.code,
          label: child.label,
          requiresNote: child.requiresNote ?? false,
          requiresPhoto: child.requiresPhoto ?? false,
          sortOrder: childOrder++,
        },
      });
    }
  }
};
