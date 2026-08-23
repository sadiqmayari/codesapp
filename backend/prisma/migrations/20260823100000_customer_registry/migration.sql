-- CodesApp-owned platform customer registry. Survives tenant deletion:
-- NO foreign key on origin_company_id, and deleteClient only stamps
-- origin_company_deleted_at (never deletes these rows). Order metrics are
-- snapshotted onto the row so they outlive the tenant's shopify_orders.
CREATE TABLE `customers` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `phone` VARCHAR(32) NOT NULL,
  `name` VARCHAR(255) NULL,
  `email` VARCHAR(255) NULL,
  `address` VARCHAR(500) NULL,
  `city` VARCHAR(128) NULL,
  `tags` JSON NOT NULL,
  `origin_company_id` INTEGER NOT NULL,
  `origin_company_name` VARCHAR(255) NOT NULL,
  `origin_company_deleted_at` DATETIME(3) NULL,
  `orders_count` INTEGER NOT NULL DEFAULT 0,
  `total_order_value` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `avg_order_value` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `last_order_at` DATETIME(3) NULL,
  `last_order_name` VARCHAR(64) NULL,
  `currency` VARCHAR(8) NULL,
  `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `last_seen_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `customers_origin_company_id_phone_key`(`origin_company_id`, `phone`),
  INDEX `customers_phone_idx`(`phone`),
  INDEX `customers_origin_company_id_idx`(`origin_company_id`),
  INDEX `customers_origin_company_deleted_at_idx`(`origin_company_deleted_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
