-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "presentmentCurrency" TEXT,
ADD COLUMN     "presentmentTotal" DECIMAL(12,2);
