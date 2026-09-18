-- Tags and notes written onto Shopify orders as a return moves along.
CREATE TYPE "OrderNoteEvent" AS ENUM ('SUBMITTED', 'APPROVED', 'RECEIVED', 'REFUNDED_CREDIT', 'REFUNDED_ORIGINAL', 'EXCHANGE_CREATED', 'EXPIRED');
CREATE TYPE "OrderNoteTarget" AS ENUM ('ORIGINAL', 'EXCHANGE');

CREATE TABLE "order_note_rules" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "event" "OrderNoteEvent" NOT NULL,
    "target" "OrderNoteTarget" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "order_note_rules_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_note_rules_merchantId_event_target_key" ON "order_note_rules"("merchantId", "event", "target");
ALTER TABLE "order_note_rules" ADD CONSTRAINT "order_note_rules_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
