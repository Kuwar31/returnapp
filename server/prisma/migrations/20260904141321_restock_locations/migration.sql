-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "restockLocationId" TEXT;

-- AlterTable
ALTER TABLE "return_line_items" ADD COLUMN     "restockLocationId" TEXT;
