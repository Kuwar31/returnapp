-- The display-currency toggle is reverted: converting figures for display
-- produced more wrong numbers than it solved, so the app renders shop
-- currency throughout again. Dropping the column rather than leaving it
-- unread, so nothing suggests a setting that no longer does anything.
ALTER TABLE "merchants" DROP COLUMN IF EXISTS "displayCurrency";
DROP TYPE IF EXISTS "DisplayCurrency";
