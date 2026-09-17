-- Per-policy label settings with an external connector, and packing slips.
ALTER TYPE "ShipmentProvider" ADD VALUE 'EXTERNAL';
CREATE TYPE "PackingSlipBarcode" AS ENUM ('RETURN_ID', 'ORDER_NUMBER');

ALTER TABLE "regional_policies"
  ADD COLUMN "generateLabels" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "labelProvider" "ShipmentProvider",
  ADD COLUMN "packingSlips" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "packingSlipTaxInclusive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "packingSlipBarcode" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "packingSlipBarcodeSource" "PackingSlipBarcode" NOT NULL DEFAULT 'ORDER_NUMBER';

ALTER TABLE "shipping_settings"
  ADD COLUMN "packingSlips" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "packingSlipTaxInclusive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "packingSlipBarcode" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "packingSlipBarcodeSource" "PackingSlipBarcode" NOT NULL DEFAULT 'ORDER_NUMBER';

ALTER TABLE "orders" ADD COLUMN "taxesIncluded" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "order_line_items" ADD COLUMN "unitTax" DECIMAL(12,2) NOT NULL DEFAULT 0;

CREATE TABLE "external_connectors" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "external_connectors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "external_connectors_merchantId_key" ON "external_connectors"("merchantId");
ALTER TABLE "external_connectors" ADD CONSTRAINT "external_connectors_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
