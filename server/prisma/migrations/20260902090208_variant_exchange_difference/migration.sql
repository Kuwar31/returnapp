-- CreateEnum
CREATE TYPE "VariantExchangeDifference" AS ENUM ('SAME_PRICE_ONLY', 'CHARGE', 'ABSORB');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "variantExchangeDifference" "VariantExchangeDifference" NOT NULL DEFAULT 'CHARGE';
