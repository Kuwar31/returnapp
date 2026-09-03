-- AlterTable
ALTER TABLE "return_policies" ADD COLUMN     "exchangeOnlyTags" TEXT[] DEFAULT ARRAY['exchange-only']::TEXT[],
ADD COLUMN     "finalSaleTags" TEXT[] DEFAULT ARRAY['final-sale']::TEXT[],
ADD COLUMN     "tagRulesEnabled" BOOLEAN NOT NULL DEFAULT false;
