-- CreateEnum
CREATE TYPE "ReturnMethodKind" AS ENUM ('LABEL', 'CARRIER', 'STORE', 'KEEP');

-- CreateEnum
CREATE TYPE "ReturnCostMode" AS ENUM ('HIDDEN', 'FREE', 'FIXED');

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "returnInstructions" TEXT,
ADD COLUMN     "returnMethod" "ReturnMethodKind",
ADD COLUMN     "returnMethodName" TEXT,
ADD COLUMN     "returnShippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "returnStoreUrl" TEXT,
ADD COLUMN     "routingRuleId" TEXT;

-- CreateTable
CREATE TABLE "return_routing_rules" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_routing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_routing_methods" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "kind" "ReturnMethodKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "costMode" "ReturnCostMode" NOT NULL DEFAULT 'HIDDEN',
    "costAmount" DECIMAL(12,2),
    "instructions" TEXT,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "storeUrl" TEXT,

    CONSTRAINT "return_routing_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "return_routing_rules_merchantId_sortOrder_idx" ON "return_routing_rules"("merchantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "return_routing_methods_ruleId_kind_key" ON "return_routing_methods"("ruleId", "kind");

-- AddForeignKey
ALTER TABLE "return_routing_rules" ADD CONSTRAINT "return_routing_rules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_routing_methods" ADD CONSTRAINT "return_routing_methods_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "return_routing_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_routingRuleId_fkey" FOREIGN KEY ("routingRuleId") REFERENCES "return_routing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
