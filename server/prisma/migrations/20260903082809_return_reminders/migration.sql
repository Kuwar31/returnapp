-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationKind" ADD VALUE 'EDITED';
ALTER TYPE "NotificationKind" ADD VALUE 'REMINDER';
ALTER TYPE "NotificationKind" ADD VALUE 'EXPIRING';
ALTER TYPE "NotificationKind" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "expiringSentAt" TIMESTAMP(3),
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);
