-- CreateEnum
CREATE TYPE "DisplayCurrency" AS ENUM ('SHOP', 'PRESENTMENT');

-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "displayCurrency" "DisplayCurrency" NOT NULL DEFAULT 'SHOP';
