-- CreateEnum
CREATE TYPE "PortalTextTone" AS ENUM ('DARK', 'LIGHT');

-- CreateEnum
CREATE TYPE "PortalRadius" AS ENUM ('SHARP', 'CURVED', 'ROUNDED');

-- AlterTable
ALTER TABLE "portal_branding" ADD COLUMN     "backgroundColor" TEXT NOT NULL DEFAULT '#f5f5f6',
ADD COLUMN     "bodyColor" TEXT NOT NULL DEFAULT '#5f6368',
ADD COLUMN     "bodyFont" TEXT NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "buttonColor" TEXT,
ADD COLUMN     "buttonTextColor" TEXT NOT NULL DEFAULT '#ffffff',
ADD COLUMN     "cornerRadius" "PortalRadius" NOT NULL DEFAULT 'CURVED',
ADD COLUMN     "emailLabel" TEXT NOT NULL DEFAULT 'Email address',
ADD COLUMN     "faviconUrl" TEXT,
ADD COLUMN     "footerHeading" TEXT,
ADD COLUMN     "footerText" TEXT,
ADD COLUMN     "headingColor" TEXT NOT NULL DEFAULT '#1a1a1c',
ADD COLUMN     "headingFont" TEXT NOT NULL DEFAULT 'SYSTEM',
ADD COLUMN     "lightLogoUrl" TEXT,
ADD COLUMN     "logoWidth" INTEGER NOT NULL DEFAULT 180,
ADD COLUMN     "lookupHelpText" TEXT,
ADD COLUMN     "orderNumberLabel" TEXT NOT NULL DEFAULT 'Order number',
ADD COLUMN     "searchEngineVisible" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "startButtonLabel" TEXT NOT NULL DEFAULT 'Find my order',
ADD COLUMN     "suggestionColor" TEXT NOT NULL DEFAULT '#6d5ce7',
ADD COLUMN     "textTone" "PortalTextTone" NOT NULL DEFAULT 'DARK';
