-- Reasons become a per-store library that groups pick from, instead of each
-- reason belonging to one group. Groups also gain product-tag conditions.

-- AlterTable
ALTER TABLE "return_reason_groups" ADD COLUMN     "productTags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "return_reason_group_entries" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "reasonId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "return_reason_group_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_reason_group_entries_reasonId_idx" ON "return_reason_group_entries"("reasonId");

-- CreateIndex
CREATE UNIQUE INDEX "return_reason_group_entries_groupId_reasonId_key" ON "return_reason_group_entries"("groupId", "reasonId");

-- AddForeignKey
ALTER TABLE "return_reason_group_entries" ADD CONSTRAINT "return_reason_group_entries_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "return_reason_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reason_group_entries" ADD CONSTRAINT "return_reason_group_entries_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "return_reasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry each group's live top-level reasons over as entries, in their order.
-- Retired reasons stay in the library for history but belong to no group.
INSERT INTO "return_reason_group_entries" ("id", "groupId", "reasonId", "sortOrder")
SELECT gen_random_uuid()::text, "groupId", "id", "sortOrder"
FROM "return_reasons"
WHERE "groupId" IS NOT NULL AND "parentId" IS NULL AND "active" = true;

-- DropForeignKey
ALTER TABLE "return_reasons" DROP CONSTRAINT "return_reasons_groupId_fkey";

-- DropIndex
DROP INDEX "return_reasons_groupId_idx";

-- AlterTable
ALTER TABLE "return_reasons" DROP COLUMN "groupId";
