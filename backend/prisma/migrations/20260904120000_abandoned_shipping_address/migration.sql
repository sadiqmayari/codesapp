-- Capture the shopper's shipping details on an abandoned checkout (when Shopify
-- sends them — i.e. the customer reached the address step, and the app has
-- Protected Customer Data access). Lets the Create-order recovery form pre-fill
-- address / city / country, not just name / phone / email. Raw columns, matching
-- this table's existing value/assignee/outcome columns (outside schema.prisma).
ALTER TABLE `shopify_abandoned_checkouts`
  ADD COLUMN `shipping_address1` VARCHAR(500) NULL,
  ADD COLUMN `shipping_address2` VARCHAR(500) NULL,
  ADD COLUMN `shipping_city` VARCHAR(255) NULL,
  ADD COLUMN `shipping_province` VARCHAR(255) NULL,
  ADD COLUMN `shipping_zip` VARCHAR(32) NULL,
  ADD COLUMN `shipping_country_code` VARCHAR(8) NULL;
