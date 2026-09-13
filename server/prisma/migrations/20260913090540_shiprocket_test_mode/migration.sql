-- AlterTable
ALTER TABLE "return_shipments" ADD COLUMN     "isTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "shiprocket_accounts" ADD COLUMN     "testMode" BOOLEAN NOT NULL DEFAULT false;

