-- Bring the display-currency toggle back.
--
-- The first attempt was dropped because figures disagreed across screens: some
-- surfaces converted and some didn't, so a portal quote and its admin detail
-- could show different numbers for the same return. The column itself was never
-- the problem — the gap was that a converted amount travelled without the
-- currency it was converted into. Every payload now carries its own currency
-- and the client reads only that, so the setting can come back.
--
-- Written forward rather than by un-applying the drop: 20260825120000 is
-- already applied in production, and rewriting applied history is how a
-- deployment ends up refusing to boot.
CREATE TYPE "DisplayCurrency" AS ENUM ('SHOP', 'PRESENTMENT');

ALTER TABLE "merchants"
  ADD COLUMN "displayCurrency" "DisplayCurrency" NOT NULL DEFAULT 'SHOP';
