-- Multi-Store / Multi-Number update — Phase 0 (schema groundwork, additive, no behavior change).
-- Stage 1 creates the Shopify-store entity + stamps; the WhatsApp-number table is
-- created now too (unused until Stage 2). All stamp columns are nullable; nothing
-- is backfilled here (backfill is a separate Phase-1 migration).

-- New connection table: Shopify stores (one primary per company, enforced in code).
CREATE TABLE `shopify_stores` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `label` VARCHAR(120) NULL,
  `shop_domain` VARCHAR(255) NOT NULL,
  `api_version` VARCHAR(16) NULL,
  `admin_token_encrypted` TEXT NOT NULL,
  `webhook_key` VARCHAR(160) NOT NULL,
  `webhook_secret_encrypted` TEXT NULL,
  `active_events` JSON NOT NULL,
  `status` ENUM('active', 'inactive', 'error') NOT NULL DEFAULT 'active',
  `is_primary` BOOLEAN NOT NULL DEFAULT false,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `shopify_stores_webhook_key_key`(`webhook_key`),
  INDEX `shopify_stores_company_id_idx`(`company_id`),
  INDEX `shopify_stores_company_id_is_primary_idx`(`company_id`, `is_primary`),
  INDEX `shopify_stores_company_id_shop_domain_idx`(`company_id`, `shop_domain`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- New connection table: WhatsApp numbers (created now, consumed in Stage 2).
CREATE TABLE `whatsapp_numbers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `waba_id` VARCHAR(64) NULL,
  `phone_number_id` VARCHAR(64) NOT NULL,
  `display_phone_number` VARCHAR(32) NULL,
  `label` VARCHAR(120) NULL,
  `access_token_encrypted` TEXT NULL,
  `webhook_key` VARCHAR(160) NOT NULL,
  `webhook_app_secret_encrypted` TEXT NULL,
  `webhook_verify_token` VARCHAR(255) NULL,
  `onboarding_status` JSON NOT NULL,
  `is_primary` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `whatsapp_numbers_phone_number_id_key`(`phone_number_id`),
  UNIQUE INDEX `whatsapp_numbers_webhook_key_key`(`webhook_key`),
  INDEX `whatsapp_numbers_company_id_idx`(`company_id`),
  INDEX `whatsapp_numbers_company_id_is_primary_idx`(`company_id`, `is_primary`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Plan-level allowances + per-extra pricing (super-admin configurable).
ALTER TABLE `subscriptions`
  ADD COLUMN `shopify_store_limit` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `whatsapp_number_limit` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `extra_store_price` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `extra_number_price` DECIMAL(10, 2) NOT NULL DEFAULT 0,
  ADD COLUMN `store_setup_fee` DECIMAL(10, 2) NULL,
  ADD COLUMN `number_setup_fee` DECIMAL(10, 2) NULL;

-- Per-company allowance overrides (NULL = plan default).
ALTER TABLE `companies`
  ADD COLUMN `shopify_store_limit_override` INTEGER NULL,
  ADD COLUMN `whatsapp_number_limit_override` INTEGER NULL;

-- Store stamp on the order-confirmation config (1:1 with a store).
ALTER TABLE `shopify_order_configs` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE UNIQUE INDEX `shopify_order_configs_shopify_store_id_key` ON `shopify_order_configs`(`shopify_store_id`);

-- Store stamps on order + fulfilment + finance rows.
ALTER TABLE `shopify_order_messages` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `shopify_order_messages_shopify_store_id_idx` ON `shopify_order_messages`(`shopify_store_id`);

ALTER TABLE `shopify_abandoned_checkouts` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `shopify_abandoned_checkouts_shopify_store_id_idx` ON `shopify_abandoned_checkouts`(`shopify_store_id`);

ALTER TABLE `shopify_orders` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `shopify_orders_company_id_shopify_store_id_idx` ON `shopify_orders`(`company_id`, `shopify_store_id`);

ALTER TABLE `payment_settlements` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `payment_settlements_shopify_store_id_idx` ON `payment_settlements`(`shopify_store_id`);

ALTER TABLE `shipments` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `shipments_company_id_shopify_store_id_idx` ON `shipments`(`company_id`, `shopify_store_id`);

ALTER TABLE `pending_order_hashes` ADD COLUMN `shopify_store_id` INTEGER NULL;

ALTER TABLE `courier_invoices` ADD COLUMN `shopify_store_id` INTEGER NULL;
CREATE INDEX `courier_invoices_shopify_store_id_idx` ON `courier_invoices`(`shopify_store_id`);

-- Conversation stamps: last store used (order picker default) + last number (Stage 2).
ALTER TABLE `conversations`
  ADD COLUMN `last_shopify_store_id` INTEGER NULL,
  ADD COLUMN `last_whatsapp_number_id` INTEGER NULL;
