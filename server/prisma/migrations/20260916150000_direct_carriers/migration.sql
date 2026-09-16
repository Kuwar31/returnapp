-- DHL Express, FedEx, Australia Post and DHL Parcel DE as return-label carriers.
ALTER TYPE "ShipmentProvider" ADD VALUE 'DHL_EXPRESS';
ALTER TYPE "ShipmentProvider" ADD VALUE 'FEDEX';
ALTER TYPE "ShipmentProvider" ADD VALUE 'AUSPOST';
ALTER TYPE "ShipmentProvider" ADD VALUE 'DEUTSCHE_POST';

CREATE TABLE "dhl_express_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "apiSecret" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dhl_express_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dhl_express_accounts_merchantId_key" ON "dhl_express_accounts"("merchantId");
ALTER TABLE "dhl_express_accounts" ADD CONSTRAINT "dhl_express_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "fedex_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "token" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "fedex_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "fedex_accounts_merchantId_key" ON "fedex_accounts"("merchantId");
ALTER TABLE "fedex_accounts" ADD CONSTRAINT "fedex_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auspost_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "accountNumber" TEXT NOT NULL,
    "testMode" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "auspost_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "auspost_accounts_merchantId_key" ON "auspost_accounts"("merchantId");
ALTER TABLE "auspost_accounts" ADD CONSTRAINT "auspost_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "dhl_parcel_de_accounts" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "billingNumber" TEXT NOT NULL,
    "sandbox" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dhl_parcel_de_accounts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "dhl_parcel_de_accounts_merchantId_key" ON "dhl_parcel_de_accounts"("merchantId");
ALTER TABLE "dhl_parcel_de_accounts" ADD CONSTRAINT "dhl_parcel_de_accounts_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
