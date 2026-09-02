-- CreateEnum
CREATE TYPE "ExchangeRuleMatch" AS ENUM ('PRODUCT_TAG', 'PRODUCT_NAME');

-- AlterTable
ALTER TABLE "order_line_items" ADD COLUMN     "productTags" TEXT[];

-- CreateTable
CREATE TABLE "exchange_rules" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "matchBy" "ExchangeRuleMatch" NOT NULL DEFAULT 'PRODUCT_TAG',
    "matchValues" TEXT[],
    "showProductTitles" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rule_options" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "collectionTitle" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "exchange_rule_options_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "exchange_rules_merchantId_active_sortOrder_idx" ON "exchange_rules"("merchantId", "active", "sortOrder");

-- CreateIndex
CREATE INDEX "exchange_rule_options_ruleId_sortOrder_idx" ON "exchange_rule_options"("ruleId", "sortOrder");

-- AddForeignKey
ALTER TABLE "exchange_rules" ADD CONSTRAINT "exchange_rules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_rule_options" ADD CONSTRAINT "exchange_rule_options_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "exchange_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
