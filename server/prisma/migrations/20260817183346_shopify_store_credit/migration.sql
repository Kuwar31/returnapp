
-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customerExternalId" TEXT;

-- AlterTable
ALTER TABLE "store_credits" ADD COLUMN     "externalAccountId" TEXT,
ADD COLUMN     "externalTransactionId" TEXT;

