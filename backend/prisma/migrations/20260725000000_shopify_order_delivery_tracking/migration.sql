-- Delivery tracking on the orders mirror, captured from Shopify fulfillments/*
-- webhooks (tracking_company + shipment_status) so courier performance covers
-- every order, not only CodesApp-booked shipments.
ALTER TABLE `shopify_orders`
  ADD COLUMN `delivery_status` VARCHAR(32) NULL,
  ADD COLUMN `tracking_company` VARCHAR(128) NULL,
  ADD COLUMN `tracking_number` VARCHAR(128) NULL,
  ADD COLUMN `delivered_at` DATETIME(3) NULL;

CREATE INDEX `shopify_orders_company_id_tracking_company_idx`
  ON `shopify_orders`(`company_id`, `tracking_company`);
