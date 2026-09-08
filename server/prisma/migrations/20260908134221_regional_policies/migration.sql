-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('FLAT', 'PERCENT');

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "regionalPolicyId" TEXT;

-- CreateTable
CREATE TABLE "regional_policies" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "countries" TEXT[],
    "destinationLocationId" TEXT,
    "windowStartsFrom" "WindowStart" NOT NULL DEFAULT 'DELIVERY',
    "bypassReview" BOOLEAN NOT NULL DEFAULT false,
    "instructions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "regional_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "regional_policy_outcomes" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "resolution" "ResolutionType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "windowDays" INTEGER,
    "feeType" "FeeType",
    "feeValue" DECIMAL(12,2),

    CONSTRAINT "regional_policy_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "regional_policies_merchantId_sortOrder_idx" ON "regional_policies"("merchantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "regional_policy_outcomes_policyId_resolution_key" ON "regional_policy_outcomes"("policyId", "resolution");

-- AddForeignKey
ALTER TABLE "regional_policies" ADD CONSTRAINT "regional_policies_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "regional_policy_outcomes" ADD CONSTRAINT "regional_policy_outcomes_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "regional_policies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_regionalPolicyId_fkey" FOREIGN KEY ("regionalPolicyId") REFERENCES "regional_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
