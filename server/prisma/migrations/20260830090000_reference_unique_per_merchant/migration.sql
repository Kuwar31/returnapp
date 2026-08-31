-- Scope return references to their merchant.
--
-- The reference is six characters from a 29-letter alphabet, about 594 million
-- combinations. Globally unique, the birthday bound puts a coin-flip chance of
-- collision at roughly 24,000 returns across every store on the platform — and
-- a collision fails a shopper's submission with a constraint error. Per
-- merchant, that threshold applies to one store's own returns.
--
-- Safe to apply as-is: every existing reference is already globally unique, so
-- it is trivially unique within its own merchant.
DROP INDEX IF EXISTS "return_requests_reference_key";

CREATE UNIQUE INDEX "return_requests_merchantId_reference_key"
  ON "return_requests" ("merchantId", "reference");
