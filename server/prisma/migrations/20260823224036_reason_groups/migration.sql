-- DropIndex
DROP INDEX "return_reasons_merchantId_code_key";

-- AlterTable
ALTER TABLE "return_reasons" ADD COLUMN     "groupId" TEXT,
ADD COLUMN     "parentId" TEXT;

-- CreateTable
CREATE TABLE "return_reason_groups" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "productTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "randomizeOrder" BOOLEAN NOT NULL DEFAULT false,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_reason_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_reason_groups_merchantId_idx" ON "return_reason_groups"("merchantId");

-- CreateIndex
CREATE INDEX "return_reasons_groupId_idx" ON "return_reasons"("groupId");

-- CreateIndex
CREATE INDEX "return_reasons_parentId_idx" ON "return_reasons"("parentId");

-- AddForeignKey
ALTER TABLE "return_reason_groups" ADD CONSTRAINT "return_reason_groups_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reasons" ADD CONSTRAINT "return_reasons_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "return_reason_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reasons" ADD CONSTRAINT "return_reasons_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "return_reasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
