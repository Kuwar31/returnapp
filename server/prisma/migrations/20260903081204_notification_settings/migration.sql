-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('SUBMITTED', 'APPROVED', 'DECLINED', 'RECEIVED', 'RESOLVED');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "senderName" TEXT;

-- CreateTable
CREATE TABLE "notification_settings" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notification_settings_merchantId_kind_key" ON "notification_settings"("merchantId", "kind");

-- AddForeignKey
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
