-- CreateEnum
CREATE TYPE "ExchangeMethod" AS ENUM ('DRAFT_ORDER', 'SHOPIFY_NATIVE');

-- AlterTable
ALTER TABLE "exchange_items" ADD COLUMN     "externalExchangeLineItemId" TEXT;

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "exchangeMethod" "ExchangeMethod" NOT NULL DEFAULT 'DRAFT_ORDER';
