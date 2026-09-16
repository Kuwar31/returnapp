-- Shippo as a fourth return-label carrier.
ALTER TYPE "ShipmentProvider" ADD VALUE 'SHIPPO';

CREATE TABLE "shippo_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "webhookSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shippo_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "shippo_accounts_merchantId_key" ON "shippo_accounts"("merchantId");
CREATE UNIQUE INDEX "shippo_accounts_webhookSecret_key" ON "shippo_accounts"("webhookSecret");

ALTER TABLE "shippo_accounts" ADD CONSTRAINT "shippo_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
