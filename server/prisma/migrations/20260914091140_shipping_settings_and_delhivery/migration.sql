-- Return labels grow a second carrier. What every carrier shares — which
-- one books, automatic booking, the destination, parcel defaults — moves
-- off the Shiprocket account into shipping_settings, one row per store.

-- AlterEnum
ALTER TYPE "ShipmentProvider" ADD VALUE 'DELHIVERY';

-- CreateTable
CREATE TABLE "shipping_settings" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "ShipmentProvider",
    "autoCreate" BOOLEAN NOT NULL DEFAULT true,
    "receiveOnDelivery" BOOLEAN NOT NULL DEFAULT true,
    "destinationId" TEXT,
    "lengthCm" DECIMAL(8,2) NOT NULL DEFAULT 20,
    "breadthCm" DECIMAL(8,2) NOT NULL DEFAULT 15,
    "heightCm" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "weightKg" DECIMAL(8,3) NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shipping_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delhivery_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "staging" BOOLEAN NOT NULL DEFAULT true,
    "warehouseName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "delhivery_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shipping_settings_merchantId_key" ON "shipping_settings"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "delhivery_accounts_merchantId_key" ON "delhivery_accounts"("merchantId");

-- AddForeignKey
ALTER TABLE "shipping_settings" ADD CONSTRAINT "shipping_settings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipping_settings" ADD CONSTRAINT "shipping_settings_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "return_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delhivery_accounts" ADD CONSTRAINT "delhivery_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry each store's settings over: a connected Shiprocket keeps booking.
INSERT INTO "shipping_settings" ("id", "merchantId", "provider", "autoCreate", "receiveOnDelivery", "destinationId", "lengthCm", "breadthCm", "heightCm", "weightKg", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "merchantId", 'SHIPROCKET', "autoCreate", "receiveOnDelivery", "destinationId", "lengthCm", "breadthCm", "heightCm", "weightKg", "createdAt", CURRENT_TIMESTAMP
FROM "shiprocket_accounts";

-- DropForeignKey
ALTER TABLE "shiprocket_accounts" DROP CONSTRAINT "shiprocket_accounts_destinationId_fkey";

-- AlterTable
ALTER TABLE "shiprocket_accounts" DROP COLUMN "autoCreate",
DROP COLUMN "breadthCm",
DROP COLUMN "destinationId",
DROP COLUMN "heightCm",
DROP COLUMN "lengthCm",
DROP COLUMN "receiveOnDelivery",
DROP COLUMN "weightKg";
