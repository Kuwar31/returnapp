-- One account, many stores.
--
-- A user was pinned to a single merchant, so a person running several Shopify
-- stores needed a separate login per store — and because logins were looked up
-- by email alone, a duplicated email could only ever reach whichever row the
-- database returned first.
--
-- Access moves to a join table. The store a request acts on is carried by the
-- session token, so every service keeps taking a merchantId exactly as before.

CREATE TABLE "memberships" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "merchantId" TEXT NOT NULL,
  "role"       "UserRole" NOT NULL DEFAULT 'AGENT',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- Carry every existing user across before their columns are dropped, so nobody
-- loses the access they already had.
INSERT INTO "memberships" ("id", "userId", "merchantId", "role", "createdAt")
SELECT
  'mem_' || "id",
  "id",
  "merchantId",
  "role",
  "createdAt"
FROM "users";

CREATE UNIQUE INDEX "memberships_userId_merchantId_key"
  ON "memberships" ("userId", "merchantId");
CREATE INDEX "memberships_merchantId_idx" ON "memberships" ("merchantId");

ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "memberships"
  ADD CONSTRAINT "memberships_merchantId_fkey"
  FOREIGN KEY ("merchantId") REFERENCES "merchants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Email becomes the account's identity. This fails loudly if the same address
-- exists under two merchants, which is the right outcome: those are two
-- passwords for one person and a human has to say which survives.
DROP INDEX IF EXISTS "users_merchantId_email_key";
DROP INDEX IF EXISTS "users_merchantId_idx";
CREATE UNIQUE INDEX "users_email_key" ON "users" ("email");

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_merchantId_fkey";
ALTER TABLE "users" DROP COLUMN "merchantId";
ALTER TABLE "users" DROP COLUMN "role";
