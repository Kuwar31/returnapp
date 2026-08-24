-- AlterTable
ALTER TABLE "return_line_items" ADD COLUMN     "acceptedQuantity" INTEGER,
ADD COLUMN     "rejectionNote" TEXT,
ADD COLUMN     "restock" BOOLEAN NOT NULL DEFAULT true;
