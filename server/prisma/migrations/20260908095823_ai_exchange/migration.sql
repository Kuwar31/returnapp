-- AlterTable
ALTER TABLE "merchants" ADD COLUMN     "aiExchangeEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "portal_branding" ADD COLUMN     "aiDetailsTitle" TEXT,
ADD COLUMN     "aiPriceCaption" TEXT,
ADD COLUMN     "aiPrimaryLabel" TEXT,
ADD COLUMN     "aiSecondaryLabel" TEXT,
ADD COLUMN     "aiSimilarTitle" TEXT,
ADD COLUMN     "aiSwitchLabel" TEXT;
