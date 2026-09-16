-- ShipStation and Sendcloud as return-label carriers, and hosted label PDFs.
ALTER TYPE "ShipmentProvider" ADD VALUE 'SHIPSTATION';
ALTER TYPE "ShipmentProvider" ADD VALUE 'SENDCLOUD';

ALTER TABLE "return_shipments" ADD COLUMN "labelData" TEXT;

CREATE TABLE "shipstation_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "testLabels" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "shipstation_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "shipstation_accounts_merchantId_key" ON "shipstation_accounts"("merchantId");
ALTER TABLE "shipstation_accounts" ADD CONSTRAINT "shipstation_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "sendcloud_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "senderAddressId" INTEGER NOT NULL,
    "senderAddress" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "sendcloud_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "sendcloud_accounts_merchantId_key" ON "sendcloud_accounts"("merchantId");
ALTER TABLE "sendcloud_accounts" ADD CONSTRAINT "sendcloud_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
