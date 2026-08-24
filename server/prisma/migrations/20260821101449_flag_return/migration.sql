-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "flagReason" TEXT,
ADD COLUMN     "flaggedAt" TIMESTAMP(3);
