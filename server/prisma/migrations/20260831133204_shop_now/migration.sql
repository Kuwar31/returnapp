-- CreateEnum
CREATE TYPE "ShopNowMode" AS ENUM ('RETURNS_PAGE', 'STOREFRONT');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "shopNowBonusAmount" DECIMAL(12,2),
ADD COLUMN     "shopNowEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopNowMode" "ShopNowMode" NOT NULL DEFAULT 'RETURNS_PAGE';

-- AlterTable
ALTER TABLE "return_requests" ADD COLUMN     "shopNow" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shopNowBonus" DECIMAL(12,2) NOT NULL DEFAULT 0;
