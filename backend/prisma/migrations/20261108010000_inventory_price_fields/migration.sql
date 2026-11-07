-- Editable + Shopify-pushable sale price (compare-at). `price` already exists
-- (synced from Shopify); add the compare-at price + a push-status pair for the
-- productVariantsBulkUpdate push (needs the write_products scope). Additive, nullable.
ALTER TABLE `inventory_variants`
  ADD COLUMN `compare_at_price`  DECIMAL(12,2) NULL,
  ADD COLUMN `price_push_status` VARCHAR(12)   NULL,
  ADD COLUMN `price_push_error`  VARCHAR(500)  NULL;
