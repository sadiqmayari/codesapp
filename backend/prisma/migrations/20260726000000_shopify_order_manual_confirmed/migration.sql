-- Manual confirmation override for Shopify orders whose customer never
-- answered (or has no) WhatsApp confirmation. Non-null => treat as confirmed.
ALTER TABLE `shopify_orders`
  ADD COLUMN `manual_confirmed_at` DATETIME(3) NULL;
