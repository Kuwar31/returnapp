-- CreateEnum
CREATE TYPE "MerchantStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'AGENT');

-- CreateEnum
CREATE TYPE "WindowStart" AS ENUM ('ORDER_DATE', 'FULFILLMENT', 'DELIVERY');

-- CreateEnum
CREATE TYPE "ReturnStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'IN_TRANSIT', 'RECEIVED', 'RESOLVED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "ResolutionType" AS ENUM ('REFUND', 'STORE_CREDIT', 'EXCHANGE', 'INSTANT_EXCHANGE', 'WARRANTY');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('PENDING', 'ACCEPTED', 'DAMAGED', 'WRONG_ITEM', 'REJECTED');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('PENDING', 'LABEL_CREATED', 'IN_TRANSIT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "ReturnEventType" AS ENUM ('CREATED', 'STATUS_CHANGED', 'NOTE_ADDED', 'LABEL_GENERATED', 'ITEM_INSPECTED', 'REFUND_ISSUED', 'CREDIT_ISSUED', 'EXCHANGE_SHIPPED', 'EMAIL_SENT');

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('SHOPIFY', 'WOOCOMMERCE', 'BIGCOMMERCE', 'CUSTOM');

-- CreateTable
CREATE TABLE "merchants" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "status" "MerchantStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'AGENT',
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portal_branding" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "headline" TEXT NOT NULL DEFAULT 'Returns & Exchanges',
    "subheadline" TEXT NOT NULL DEFAULT 'Start a return or exchange in a few clicks',
    "logoUrl" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#111213',
    "supportEmail" TEXT,
    "policyUrl" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portal_branding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_policies" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "returnWindowDays" INTEGER NOT NULL DEFAULT 30,
    "windowStartsFrom" "WindowStart" NOT NULL DEFAULT 'DELIVERY',
    "allowFinalSale" BOOLEAN NOT NULL DEFAULT false,
    "requirePhotoProof" BOOLEAN NOT NULL DEFAULT false,
    "allowRefund" BOOLEAN NOT NULL DEFAULT true,
    "allowStoreCredit" BOOLEAN NOT NULL DEFAULT true,
    "allowExchange" BOOLEAN NOT NULL DEFAULT true,
    "allowInstantExchange" BOOLEAN NOT NULL DEFAULT false,
    "bonusCreditPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "restockingFeePercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "returnShippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "waiveShippingOnCredit" BOOLEAN NOT NULL DEFAULT true,
    "autoApprove" BOOLEAN NOT NULL DEFAULT false,
    "autoApproveUnder" DECIMAL(12,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_reasons" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "requiresNote" BOOLEAN NOT NULL DEFAULT false,
    "requiresPhoto" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "return_reasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "policyId" TEXT,
    "externalId" TEXT,
    "orderNumber" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "customerName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "placedAt" TIMESTAMP(3) NOT NULL,
    "fulfilledAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "shippingAddress" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_line_items" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalId" TEXT,
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "finalSale" BOOLEAN NOT NULL DEFAULT false,
    "returnedQuantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "order_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_requests" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "policyId" TEXT,
    "reference" TEXT NOT NULL,
    "status" "ReturnStatus" NOT NULL DEFAULT 'SUBMITTED',
    "resolution" "ResolutionType" NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "customerNote" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "itemsSubtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "bonusCredit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "restockingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "estimatedTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "settledTotal" DECIMAL(12,2),
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_line_items" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "orderLineItemId" TEXT NOT NULL,
    "reasonId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "reasonNote" TEXT,
    "photoUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "lineTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "inspection" "InspectionResult",

    CONSTRAINT "return_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_items" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "imageUrl" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "priceDifference" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "exchange_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_shipments" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "labelUrl" TEXT,
    "status" "ShipmentStatus" NOT NULL DEFAULT 'PENDING',
    "labelCost" DECIMAL(12,2),
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "return_shipments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "store_credits" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "returnRequestId" TEXT,
    "code" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "balance" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "store_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "return_events" (
    "id" TEXT NOT NULL,
    "returnRequestId" TEXT NOT NULL,
    "actorId" TEXT,
    "type" "ReturnEventType" NOT NULL,
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "return_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "accessToken" TEXT,
    "scopes" TEXT,
    "externalShopId" TEXT,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSyncedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "merchants_slug_key" ON "merchants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "merchants_domain_key" ON "merchants"("domain");

-- CreateIndex
CREATE INDEX "users_merchantId_idx" ON "users"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "users_merchantId_email_key" ON "users"("merchantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "portal_branding_merchantId_key" ON "portal_branding"("merchantId");

-- CreateIndex
CREATE INDEX "return_policies_merchantId_idx" ON "return_policies"("merchantId");

-- CreateIndex
CREATE INDEX "return_reasons_merchantId_idx" ON "return_reasons"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "return_reasons_merchantId_code_key" ON "return_reasons"("merchantId", "code");

-- CreateIndex
CREATE INDEX "orders_merchantId_email_idx" ON "orders"("merchantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "orders_merchantId_orderNumber_key" ON "orders"("merchantId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "orders_merchantId_externalId_key" ON "orders"("merchantId", "externalId");

-- CreateIndex
CREATE INDEX "order_line_items_orderId_idx" ON "order_line_items"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "return_requests_reference_key" ON "return_requests"("reference");

-- CreateIndex
CREATE INDEX "return_requests_merchantId_status_idx" ON "return_requests"("merchantId", "status");

-- CreateIndex
CREATE INDEX "return_requests_merchantId_submittedAt_idx" ON "return_requests"("merchantId", "submittedAt");

-- CreateIndex
CREATE INDEX "return_requests_orderId_idx" ON "return_requests"("orderId");

-- CreateIndex
CREATE INDEX "return_line_items_returnRequestId_idx" ON "return_line_items"("returnRequestId");

-- CreateIndex
CREATE INDEX "exchange_items_returnRequestId_idx" ON "exchange_items"("returnRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "return_shipments_returnRequestId_key" ON "return_shipments"("returnRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "store_credits_returnRequestId_key" ON "store_credits"("returnRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "store_credits_code_key" ON "store_credits"("code");

-- CreateIndex
CREATE INDEX "store_credits_merchantId_customerEmail_idx" ON "store_credits"("merchantId", "customerEmail");

-- CreateIndex
CREATE INDEX "return_events_returnRequestId_createdAt_idx" ON "return_events"("returnRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "integrations_merchantId_provider_key" ON "integrations"("merchantId", "provider");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portal_branding" ADD CONSTRAINT "portal_branding_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_policies" ADD CONSTRAINT "return_policies_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_reasons" ADD CONSTRAINT "return_reasons_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "return_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_line_items" ADD CONSTRAINT "order_line_items_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "return_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_requests" ADD CONSTRAINT "return_requests_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_line_items" ADD CONSTRAINT "return_line_items_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_line_items" ADD CONSTRAINT "return_line_items_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "order_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_line_items" ADD CONSTRAINT "return_line_items_reasonId_fkey" FOREIGN KEY ("reasonId") REFERENCES "return_reasons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exchange_items" ADD CONSTRAINT "exchange_items_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_shipments" ADD CONSTRAINT "return_shipments_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_returnRequestId_fkey" FOREIGN KEY ("returnRequestId") REFERENCES "return_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "return_events" ADD CONSTRAINT "return_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
