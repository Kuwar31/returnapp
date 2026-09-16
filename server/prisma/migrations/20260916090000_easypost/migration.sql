-- EasyPost as a third return-label carrier, and a shipping email for labels.
ALTER TYPE "ShipmentProvider" ADD VALUE 'EASYPOST';

ALTER TABLE "shipping_settings" ADD COLUMN "shippingEmail" TEXT;

CREATE TABLE "easypost_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "webhookSecret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "easypost_accounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "easypost_accounts_merchantId_key" ON "easypost_accounts"("merchantId");
CREATE UNIQUE INDEX "easypost_accounts_webhookSecret_key" ON "easypost_accounts"("webhookSecret");

ALTER TABLE "easypost_accounts" ADD CONSTRAINT "easypost_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
