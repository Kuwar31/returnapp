-- AlterTable
ALTER TABLE "shiprocket_accounts" ADD COLUMN     "destinationId" TEXT;

-- AddForeignKey
ALTER TABLE "shiprocket_accounts" ADD CONSTRAINT "shiprocket_accounts_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "return_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

