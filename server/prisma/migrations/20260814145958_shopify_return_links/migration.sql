
-- AlterTable
ALTER TABLE "return_line_items" ADD COLUMN     "externalReturnLineItemId" TEXT,
ADD COLUMN     "fulfillmentLineItemId" TEXT;

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "externalRefundId" TEXT,
ADD COLUMN     "externalReturnId" TEXT,
ADD COLUMN     "externalStatus" TEXT;

