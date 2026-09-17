-- AfterShip-shaped return shipping: package sizes, warehouse contacts,
-- per-rule return shipping information, label settings and slip methods.
CREATE TYPE "LengthUnit" AS ENUM ('CM', 'IN');
CREATE TYPE "MassUnit" AS ENUM ('KG', 'LB');

ALTER TABLE "return_destinations"
  ADD COLUMN "company" TEXT,
  ADD COLUMN "contactName" TEXT,
  ADD COLUMN "email" TEXT;

CREATE TABLE "package_sizes" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "length" DECIMAL(8,2) NOT NULL,
    "width" DECIMAL(8,2) NOT NULL,
    "height" DECIMAL(8,2) NOT NULL,
    "unit" "LengthUnit" NOT NULL DEFAULT 'CM',
    "weight" DECIMAL(8,3) NOT NULL,
    "massUnit" "MassUnit" NOT NULL DEFAULT 'KG',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "package_sizes_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "package_sizes_merchantId_idx" ON "package_sizes"("merchantId");
ALTER TABLE "package_sizes" ADD CONSTRAINT "package_sizes_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Every store that had label defaults keeps them as its default package.
INSERT INTO "package_sizes" ("id", "merchantId", "name", "length", "width", "height", "unit", "weight", "massUnit", "isDefault", "createdAt", "updatedAt")
SELECT 'pkg_' || substr(md5(random()::text || s."merchantId"), 1, 20), s."merchantId", 'Default package', s."lengthCm", s."breadthCm", s."heightCm", 'CM', s."weightKg", 'KG', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "shipping_settings" s;

ALTER TABLE "return_routing_methods"
  ADD COLUMN "carrier" "ShipmentProvider",
  ADD COLUMN "serviceName" TEXT,
  ADD COLUMN "destinationId" TEXT,
  ADD COLUMN "packageSizeId" TEXT;
ALTER TABLE "return_routing_methods" ADD CONSTRAINT "return_routing_methods_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "return_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "return_routing_methods" ADD CONSTRAINT "return_routing_methods_packageSizeId_fkey" FOREIGN KEY ("packageSizeId") REFERENCES "package_sizes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "shipping_settings"
  ADD COLUMN "packingSlipMethods" "ReturnMethodKind"[] DEFAULT ARRAY['LABEL', 'CARRIER', 'STORE']::"ReturnMethodKind"[],
  ADD COLUMN "autoCancelDays" INTEGER,
  ADD COLUMN "labelReferences" JSONB NOT NULL DEFAULT '[]';
