-- CreateEnum
CREATE TYPE "LookupCriterion" AS ENUM ('EMAIL', 'ZIP', 'PHONE');

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "portal_branding" ADD COLUMN     "lookupCriteria" "LookupCriterion"[] DEFAULT ARRAY['EMAIL']::"LookupCriterion"[],
ADD COLUMN     "phoneLabel" TEXT NOT NULL DEFAULT 'Phone number',
ADD COLUMN     "zipLabel" TEXT NOT NULL DEFAULT 'Postal code';
