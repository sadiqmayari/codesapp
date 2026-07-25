-- Archived/closed marker on the orders mirror. Set when an order is no longer
-- open in Shopify (archived). Hidden from the working queue views, kept for
-- records + courier performance.
ALTER TABLE `shopify_orders` ADD COLUMN `archived_at` DATETIME(3) NULL;

CREATE INDEX `shopify_orders_company_id_archived_at_idx`
  ON `shopify_orders`(`company_id`, `archived_at`);
