-- CreateEnum
CREATE TYPE "BonusType" AS ENUM ('PERCENT', 'FIXED');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "exchangeBonusType" "BonusType" NOT NULL DEFAULT 'PERCENT',
ADD COLUMN     "exchangeBonusValue" DECIMAL(12,2),
ADD COLUMN     "shopNowBonusType" "BonusType" NOT NULL DEFAULT 'FIXED';
