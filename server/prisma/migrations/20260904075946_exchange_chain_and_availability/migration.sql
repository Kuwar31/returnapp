-- AlterTable
ALTER TABLE "return_policies" ADD COLUMN     "allowExchangeOfExchange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "matchStoreAvailability" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sequentialExchangeLimit" INTEGER;
