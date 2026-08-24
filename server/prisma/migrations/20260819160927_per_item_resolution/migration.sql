
-- AlterTable
ALTER TABLE "exchange_items" ADD COLUMN     "returnLineItemId" TEXT;

-- AlterTable
ALTER TABLE "return_line_items" ADD COLUMN     "resolution" "ResolutionType" NOT NULL DEFAULT 'REFUND';

-- AddForeignKey
ALTER TABLE "exchange_items" ADD CONSTRAINT "exchange_items_returnLineItemId_fkey" FOREIGN KEY ("returnLineItemId") REFERENCES "return_line_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: existing line items inherit the resolution their return was
-- created with, so historical returns keep reading correctly rather than all
-- appearing as refunds.
UPDATE "return_line_items" li
SET "resolution" = r."resolution"
FROM "return_requests" r
WHERE r."id" = li."returnRequestId";

-- Link existing exchange items to the single line they must have belonged to,
-- which is unambiguous only when the return had exactly one line.
UPDATE "exchange_items" e
SET "returnLineItemId" = li."id"
FROM "return_line_items" li
WHERE li."returnRequestId" = e."returnRequestId"
  AND (SELECT COUNT(*) FROM "return_line_items" x
       WHERE x."returnRequestId" = e."returnRequestId") = 1;
