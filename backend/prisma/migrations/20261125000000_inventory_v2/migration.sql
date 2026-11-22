-- Inventory v2: master items, locations, per-location levels, push state,
-- suppliers/POs/receipts, counts, transfers, cost history, waitlist,
-- product publish jobs. Additive only; the items/locations/levels backfill
-- runs in the app (InventoryBootstrapService) so it is testable + re-runnable.
-- New tables inherit the DB collation (same as inventory_variants).
-- AlterTable
ALTER TABLE `companies` ADD COLUMN `inventory_settings` JSON NULL,
    ADD COLUMN `inventory_v2_at` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `inventory_products` ADD COLUMN `description_html` MEDIUMTEXT NULL,
    ADD COLUMN `publications` JSON NULL,
    ADD COLUMN `status_push_error` VARCHAR(500) NULL,
    ADD COLUMN `status_push_status` VARCHAR(12) NULL,
    ADD COLUMN `tags` JSON NULL;

-- AlterTable
ALTER TABLE `inventory_variants` ADD COLUMN `item_id` INTEGER NULL,
    ADD COLUMN `link_source` VARCHAR(12) NULL,
    ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT 'shopify';

-- AlterTable
ALTER TABLE `inventory_movements` ADD COLUMN `idem_key` VARCHAR(191) NULL,
    ADD COLUMN `item_id` INTEGER NULL,
    ADD COLUMN `location_id` INTEGER NULL,
    ADD COLUMN `note` VARCHAR(500) NULL,
    ADD COLUMN `ref_type` VARCHAR(16) NULL,
    MODIFY `variant_id` INTEGER NULL;

-- CreateTable
CREATE TABLE `inventory_items` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `sku` VARCHAR(160) NULL,
    `barcode` VARCHAR(160) NULL,
    `title` VARCHAR(400) NOT NULL,
    `variant_title` VARCHAR(255) NULL,
    `image_url` VARCHAR(1000) NULL,
    `item_code` VARCHAR(80) NULL,
    `alias` VARCHAR(120) NULL,
    `category` VARCHAR(120) NULL,
    `shelf_location` VARCHAR(120) NULL,
    `reorder_level` INTEGER NOT NULL DEFAULT 0,
    `reorder_qty` INTEGER NULL,
    `lead_time_days` INTEGER NULL,
    `avg_cost` DECIMAL(12, 2) NULL,
    `track` BOOLEAN NOT NULL DEFAULT true,
    `allow_backorder` BOOLEAN NOT NULL DEFAULT false,
    `is_bundle` BOOLEAN NOT NULL DEFAULT false,
    `bundle_components` JSON NULL,
    `supplier_id` INTEGER NULL,
    `notes` TEXT NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `inventory_items_company_id_sku_idx`(`company_id`, `sku`),
    INDEX `inventory_items_company_id_barcode_idx`(`company_id`, `barcode`),
    INDEX `inventory_items_company_id_item_code_idx`(`company_id`, `item_code`),
    INDEX `inventory_items_company_id_title_idx`(`company_id`, `title`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `inventory_locations` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `address` VARCHAR(500) NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `is_default` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `inventory_locations_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `inventory_location_links` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `location_id` INTEGER NOT NULL,
    `store_id` INTEGER NOT NULL,
    `external_location_gid` VARCHAR(120) NOT NULL,
    `external_name` VARCHAR(160) NULL,
    `sync_enabled` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `inventory_location_links_company_id_location_id_idx`(`company_id`, `location_id`),
    UNIQUE INDEX `inventory_location_links_company_id_store_id_external_locati_key`(`company_id`, `store_id`, `external_location_gid`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `inventory_levels` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `location_id` INTEGER NOT NULL,
    `available` INTEGER NOT NULL DEFAULT 0,
    `committed` INTEGER NOT NULL DEFAULT 0,
    `incoming` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `inventory_levels_company_id_location_id_idx`(`company_id`, `location_id`),
    UNIQUE INDEX `inventory_levels_item_id_location_id_key`(`item_id`, `location_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `listing_push_state` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `variant_id` INTEGER NOT NULL,
    `location_link_id` INTEGER NOT NULL,
    `last_seen` INTEGER NULL,
    `committed` INTEGER NOT NULL DEFAULT 0,
    `last_pushed` INTEGER NULL,
    `pushed_at` DATETIME(3) NULL,
    `status` VARCHAR(12) NULL,
    `error` VARCHAR(500) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `listing_push_state_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `listing_push_state_variant_id_location_link_id_key`(`variant_id`, `location_link_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `suppliers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `contact_name` VARCHAR(120) NULL,
    `phone` VARCHAR(40) NULL,
    `email` VARCHAR(160) NULL,
    `address` VARCHAR(500) NULL,
    `notes` TEXT NULL,
    `lead_time_days` INTEGER NULL,
    `archived_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `suppliers_company_id_idx`(`company_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `supplier_id` INTEGER NULL,
    `location_id` INTEGER NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
    `expected_at` DATETIME(3) NULL,
    `sent_at` DATETIME(3) NULL,
    `notes` TEXT NULL,
    `freight` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `paid_amount` DECIMAL(14, 2) NOT NULL DEFAULT 0,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `purchase_orders_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `purchase_orders_company_id_number_key`(`company_id`, `number`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `purchase_order_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `po_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `qty_ordered` INTEGER NOT NULL,
    `qty_received` INTEGER NOT NULL DEFAULT 0,
    `unit_cost` DECIMAL(12, 2) NOT NULL,

    INDEX `purchase_order_lines_company_id_item_id_idx`(`company_id`, `item_id`),
    UNIQUE INDEX `purchase_order_lines_po_id_item_id_key`(`po_id`, `item_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `goods_receipts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `po_id` INTEGER NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `freight` DECIMAL(12, 2) NOT NULL DEFAULT 0,
    `received_by` INTEGER NULL,
    `note` VARCHAR(500) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `goods_receipts_company_id_number_key`(`company_id`, `number`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `goods_receipt_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `receipt_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `qty` INTEGER NOT NULL,
    `unit_cost` DECIMAL(12, 2) NOT NULL,
    `landed_cost` DECIMAL(12, 2) NOT NULL,

    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `stock_counts` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `location_id` INTEGER NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
    `blind` BOOLEAN NOT NULL DEFAULT true,
    `scope` VARCHAR(160) NULL,
    `started_by` INTEGER NULL,
    `applied_by` INTEGER NULL,
    `applied_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `stock_counts_company_id_status_idx`(`company_id`, `status`),
    UNIQUE INDEX `stock_counts_company_id_number_key`(`company_id`, `number`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `stock_count_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `count_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `expected` INTEGER NOT NULL,
    `counted` INTEGER NULL,
    `reason` VARCHAR(24) NULL,
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stock_count_lines_count_id_item_id_key`(`count_id`, `item_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `stock_transfers` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `from_location_id` INTEGER NOT NULL,
    `to_location_id` INTEGER NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
    `note` VARCHAR(500) NULL,
    `created_by` INTEGER NULL,
    `sent_at` DATETIME(3) NULL,
    `received_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stock_transfers_company_id_number_key`(`company_id`, `number`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `stock_transfer_lines` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `transfer_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `qty` INTEGER NOT NULL,

    UNIQUE INDEX `stock_transfer_lines_transfer_id_item_id_key`(`transfer_id`, `item_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `inventory_cost_history` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `old_cost` DECIMAL(12, 2) NULL,
    `new_cost` DECIMAL(12, 2) NULL,
    `source` VARCHAR(16) NOT NULL,
    `ref` VARCHAR(120) NULL,
    `actor_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `inventory_cost_history_company_id_item_id_idx`(`company_id`, `item_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `stock_waitlist` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `item_id` INTEGER NOT NULL,
    `contact_id` INTEGER NOT NULL,
    `added_by` INTEGER NULL,
    `notified_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_waitlist_company_id_item_id_notified_at_idx`(`company_id`, `item_id`, `notified_at`),
    UNIQUE INDEX `stock_waitlist_company_id_item_id_contact_id_key`(`company_id`, `item_id`, `contact_id`),
    PRIMARY KEY (`id`)
);

-- CreateTable
CREATE TABLE `product_publish_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `batch_key` VARCHAR(40) NOT NULL,
    `store_id` INTEGER NOT NULL,
    `action` VARCHAR(12) NOT NULL,
    `payload` JSON NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'pending',
    `error` VARCHAR(1000) NULL,
    `product_gid` VARCHAR(120) NULL,
    `created_by` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `product_publish_jobs_company_id_batch_key_idx`(`company_id`, `batch_key`),
    PRIMARY KEY (`id`)
);

-- CreateIndex
CREATE INDEX `inventory_variants_company_id_item_id_idx` ON `inventory_variants`(`company_id`, `item_id`);

-- CreateIndex
CREATE INDEX `inventory_movements_company_id_item_id_created_at_idx` ON `inventory_movements`(`company_id`, `item_id`, `created_at`);

-- CreateIndex
CREATE INDEX `inventory_movements_company_id_created_at_idx` ON `inventory_movements`(`company_id`, `created_at`);

-- CreateIndex
CREATE UNIQUE INDEX `inventory_movements_company_id_idem_key_key` ON `inventory_movements`(`company_id`, `idem_key`);

-- AddForeignKey
ALTER TABLE `inventory_variants` ADD CONSTRAINT `inventory_variants_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_items` ADD CONSTRAINT `inventory_items_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_location_links` ADD CONSTRAINT `inventory_location_links_location_id_fkey` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_levels` ADD CONSTRAINT `inventory_levels_item_id_fkey` FOREIGN KEY (`item_id`) REFERENCES `inventory_items`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inventory_levels` ADD CONSTRAINT `inventory_levels_location_id_fkey` FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `listing_push_state` ADD CONSTRAINT `listing_push_state_variant_id_fkey` FOREIGN KEY (`variant_id`) REFERENCES `inventory_variants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `listing_push_state` ADD CONSTRAINT `listing_push_state_location_link_id_fkey` FOREIGN KEY (`location_link_id`) REFERENCES `inventory_location_links`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_orders` ADD CONSTRAINT `purchase_orders_supplier_id_fkey` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_po_id_fkey` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipts` ADD CONSTRAINT `goods_receipts_po_id_fkey` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_lines` ADD CONSTRAINT `goods_receipt_lines_receipt_id_fkey` FOREIGN KEY (`receipt_id`) REFERENCES `goods_receipts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_count_lines` ADD CONSTRAINT `stock_count_lines_count_id_fkey` FOREIGN KEY (`count_id`) REFERENCES `stock_counts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transfer_lines` ADD CONSTRAINT `stock_transfer_lines_transfer_id_fkey` FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

