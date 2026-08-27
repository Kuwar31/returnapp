-- Where a trade-down's leftover value goes.
--
-- An exchange line's resolution is already EXCHANGE, so it has no room to say
-- how the shopper wants the difference back. Defaulting to REFUND keeps every
-- existing return behaving exactly as it does today.
CREATE TYPE "ExchangeSurplusMethod" AS ENUM ('REFUND', 'STORE_CREDIT', 'GIFT_CARD');

ALTER TABLE "return_requests"
  ADD COLUMN "exchangeSurplusMethod" "ExchangeSurplusMethod" NOT NULL DEFAULT 'REFUND';
