-- "Exchange for another product", narrowed to products with similar names.
ALTER TABLE "merchants" ADD COLUMN "similarExchangeEnabled" BOOLEAN NOT NULL DEFAULT false;
