-- Abandoned-cart recovery: track pending checkouts + a per-tenant recovery delay.
ALTER TABLE `shopify_order_configs`
  ADD COLUMN `abandoned_cart_delay_minutes` INT NULL;

CREATE TABLE `shopify_abandoned_checkouts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `checkout_token` VARCHAR(128) NOT NULL,
  `phone` VARCHAR(32) NULL,
  `recovery_url` TEXT NULL,
  `contact_name` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `items_summary` TEXT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `shopify_abandoned_checkouts_company_id_checkout_token_key` (`company_id`, `checkout_token`),
  INDEX `shopify_abandoned_checkouts_company_id_status_idx` (`company_id`, `status`)
) DEFAULT CHARACTER SET utf8mb4;
