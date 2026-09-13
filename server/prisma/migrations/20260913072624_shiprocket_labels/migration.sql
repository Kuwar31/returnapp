-- CreateEnum
CREATE TYPE "ShipmentProvider" AS ENUM ('SHIPROCKET');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'LABEL_READY';

-- AlterEnum
ALTER TYPE "ShipmentStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "return_shipments" ADD COLUMN     "etd" TIMESTAMP(3),
ADD COLUMN     "externalOrderId" TEXT,
ADD COLUMN     "externalShipmentId" TEXT,
ADD COLUMN     "externalStatus" TEXT,
ADD COLUMN     "externalStatusId" INTEGER,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastTrackedAt" TIMESTAMP(3),
ADD COLUMN     "pickupScheduledAt" TIMESTAMP(3),
ADD COLUMN     "pickupToken" TEXT,
ADD COLUMN     "provider" "ShipmentProvider",
ADD COLUMN     "scans" JSONB;

-- CreateTable
CREATE TABLE "shiprocket_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "token" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "webhookSecret" TEXT NOT NULL,
    "autoCreate" BOOLEAN NOT NULL DEFAULT true,
    "receiveOnDelivery" BOOLEAN NOT NULL DEFAULT true,
    "qcEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lengthCm" DECIMAL(8,2) NOT NULL DEFAULT 20,
    "breadthCm" DECIMAL(8,2) NOT NULL DEFAULT 15,
    "heightCm" DECIMAL(8,2) NOT NULL DEFAULT 10,
    "weightKg" DECIMAL(8,3) NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shiprocket_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shiprocket_accounts_merchantId_key" ON "shiprocket_accounts"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "shiprocket_accounts_webhookSecret_key" ON "shiprocket_accounts"("webhookSecret");

-- CreateIndex
CREATE INDEX "return_shipments_provider_status_idx" ON "return_shipments"("provider", "status");

-- AddForeignKey
ALTER TABLE "shiprocket_accounts" ADD CONSTRAINT "shiprocket_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

