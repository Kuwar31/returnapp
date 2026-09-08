/*
  Warnings:

  - You are about to drop the `exchange_rule_options` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "ExchangeOfferMatch" AS ENUM ('PRODUCT_TAG', 'PRODUCT_TYPE', 'COLLECTION');

-- CreateEnum
CREATE TYPE "ExchangePricing" AS ENUM ('EVEN', 'DIFFERENCE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ExchangeRuleMatch" ADD VALUE 'PRODUCT_TYPE';
ALTER TYPE "ExchangeRuleMatch" ADD VALUE 'COLLECTION';

-- DropForeignKey
ALTER TABLE "exchange_rule_options" DROP CONSTRAINT "exchange_rule_options_ruleId_fkey";

-- AlterTable
ALTER TABLE "exchange_items" ADD COLUMN     "evenExchange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "ruleId" TEXT;

-- AlterTable
ALTER TABLE "exchange_rules" ADD COLUMN     "allowNote" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inStockOnly" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "offerBy" "ExchangeOfferMatch" NOT NULL DEFAULT 'COLLECTION',
ADD COLUMN     "offerValues" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "pricing" "ExchangePricing" NOT NULL DEFAULT 'DIFFERENCE';

-- Carry existing rules over. A rule used to hold one or more collection
-- options; a group holds exactly one offer. The first option folds into the
-- rule itself, named as the shopper saw it; any further options become groups
-- of their own, cloned from the rule and keeping the option's id. A rule with
-- no options keeps an empty offer, which never matches — as it never did.
INSERT INTO "exchange_rules" (
  "id", "merchantId", "name", "active", "sortOrder", "matchBy", "matchValues",
  "showProductTitles", "bonusType", "bonusValue", "createdAt", "updatedAt",
  "offerBy", "offerValues", "pricing", "inStockOnly", "allowNote"
)
SELECT
  o."id", r."merchantId", o."label", r."active", r."sortOrder", r."matchBy", r."matchValues",
  r."showProductTitles", r."bonusType", r."bonusValue", r."createdAt", NOW(),
  'COLLECTION', ARRAY[o."collectionId"], 'DIFFERENCE', true, false
FROM "exchange_rule_options" o
JOIN "exchange_rules" r ON r."id" = o."ruleId"
WHERE o."id" <> (
  SELECT o2."id" FROM "exchange_rule_options" o2
  WHERE o2."ruleId" = o."ruleId"
  ORDER BY o2."sortOrder" ASC, o2."id" ASC
  LIMIT 1
);

UPDATE "exchange_rules" r
SET "name" = o."label", "offerBy" = 'COLLECTION', "offerValues" = ARRAY[o."collectionId"]
FROM (
  SELECT DISTINCT ON ("ruleId") "ruleId", "label", "collectionId"
  FROM "exchange_rule_options"
  ORDER BY "ruleId", "sortOrder" ASC, "id" ASC
) o
WHERE o."ruleId" = r."id";

-- DropTable
DROP TABLE "exchange_rule_options";
