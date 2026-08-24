-- CreateEnum
CREATE TYPE "CreditKind" AS ENUM ('STORE_CREDIT', 'GIFT_CARD');

-- AlterEnum
ALTER TYPE "ResolutionType" ADD VALUE 'GIFT_CARD';

-- AlterTable
ALTER TABLE "return_policies" ADD COLUMN "allowGiftCard" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "store_credits" ADD COLUMN "kind" "CreditKind" NOT NULL DEFAULT 'STORE_CREDIT';
