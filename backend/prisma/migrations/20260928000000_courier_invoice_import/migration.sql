-- Invoice import (super-admin gated, per-tenant file format) + the courier
-- invoice number stamped onto orders, matched by order number.

ALTER TABLE `companies`
  ADD COLUMN `invoice_import_enabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `invoice_import_format` VARCHAR(64) NULL;

ALTER TABLE `shopify_orders`
  ADD COLUMN `courier_invoice_number` VARCHAR(64) NULL,
  ADD COLUMN `courier_invoice_amount` DECIMAL(12, 2) NULL,
  ADD COLUMN `courier_invoice_date` DATETIME(3) NULL,
  ADD COLUMN `courier_invoice_courier` VARCHAR(32) NULL;
