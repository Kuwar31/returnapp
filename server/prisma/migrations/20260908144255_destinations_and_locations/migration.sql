/*
  Warnings:

  - You are about to drop the column `destinationLocationId` on the `regional_policies` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "FeeType" ADD VALUE 'PRODUCT_TAG';

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "inventoryLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "regional_policies" DROP COLUMN "destinationLocationId",
ADD COLUMN     "allowAdvancedExchange" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowInstantExchange" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "destinationId" TEXT,
ADD COLUMN     "exchangeShippingMethod" TEXT,
ADD COLUMN     "inventoryLocationIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "return_destinations" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address1" TEXT NOT NULL,
    "address2" TEXT,
    "city" TEXT NOT NULL,
    "province" TEXT,
    "zip" TEXT,
    "countryCode" TEXT NOT NULL,
    "phone" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "locationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_destinations_merchantId_idx" ON "return_destinations"("merchantId");

-- AddForeignKey
ALTER TABLE "regional_policies" ADD CONSTRAINT "regional_policies_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "return_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_destinations" ADD CONSTRAINT "return_destinations_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
