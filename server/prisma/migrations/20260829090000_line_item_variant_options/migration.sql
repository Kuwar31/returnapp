-- The option names behind a variant title.
--
-- Shopify's variantTitle is only the values — "37", or "Blue / M" — so the
-- portal was showing shoppers a bare "1" under a product name with nothing to
-- say what it measured. Nullable: orders synced before this have no options
-- recorded, and fall back to the bare title they show today.
ALTER TABLE "order_line_items" ADD COLUMN "variantOptions" JSONB;
