-- CreateEnum
CREATE TYPE "ExchangeDraftStatus" AS ENUM ('OPEN', 'INVOICE_SENT', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "exchange_draft_orders" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT,
    "invoiceUrl" TEXT,
    "status" "ExchangeDraftStatus" NOT NULL DEFAULT 'OPEN',
    "currency" TEXT NOT NULL,
    "itemsTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "creditApplied" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "balanceDue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reservedUntil" TIMESTAMP(3),
    "invoiceSentAt" TIMESTAMP(3),
    "externalOrderId" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_draft_orders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_draft_orders_returnRequestId_key" ON "exchange_draft_orders"("returnRequestId");

-- CreateIndex
CREATE INDEX "exchange_draft_orders_externalId_idx" ON "exchange_draft_orders"("externalId");

-- AddForeignKey
ALTER TABLE "exchange_draft_orders" ADD CONSTRAINT "exchange_draft_orders_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
