-- Native courier fulfillment + tracking (replaces the tenant's Google Sheet +
-- n8n workflows for Trax/Leopards/PostEx/Rocket). Four new additive tables,
-- no changes to existing columns, no backfill.
--
-- CourierCredential: per-company, per-courier encrypted API credentials.
-- webhook_key is the per-tenant unguessable token embedded in the inbound
-- courier webhook URL (fixes the cross-tenant leak found in the tenant's
-- n8n Leopards webhook, which silently served a second, unrelated store).
CREATE TABLE `courier_credentials` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `courier_type` ENUM('trax', 'leopards', 'postex', 'rocket') NOT NULL,
    `credentials_encrypted` TEXT NOT NULL,
    `webhook_secret_encrypted` TEXT NULL,
    `webhook_key` VARCHAR(64) NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `courier_credentials_company_id_courier_type_key`(`company_id`, `courier_type`),
    UNIQUE INDEX `courier_credentials_webhook_key_key`(`webhook_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- CourierCityMapping: city name -> per-courier city code. company_id NULL =
-- platform seed default (loaded from the tenant's existing sheet lookup
-- tabs); a company_id-scoped row overrides the seed for the same courier+city.
CREATE TABLE `courier_city_mappings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NULL,
    `courier_type` ENUM('trax', 'leopards', 'postex', 'rocket') NOT NULL,
    `city_name` VARCHAR(128) NOT NULL,
    `city_code` VARCHAR(32) NOT NULL,
    `is_default_courier` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `courier_city_mappings_company_id_courier_type_city_name_key`(`company_id`, `courier_type`, `city_name`),
    INDEX `courier_city_mappings_courier_type_city_name_idx`(`courier_type`, `city_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- LoadsheetBatch: one row per courier pickup-manifest generation run.
CREATE TABLE `loadsheet_batches` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `courier_type` ENUM('trax', 'leopards', 'postex', 'rocket') NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `courier_loadsheet_id` VARCHAR(128) NULL,
    `pdf_media_url` VARCHAR(500) NULL,
    `shipment_count` INTEGER NOT NULL DEFAULT 0,
    `error` TEXT NULL,
    `created_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completed_at` DATETIME(3) NULL,

    INDEX `loadsheet_batches_company_id_courier_type_status_idx`(`company_id`, `courier_type`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- Shipment: native replacement for a Google Sheet fulfillment row — one per
-- Shopify order, tracking courier/tracking-number/status. address_issue is a
-- first-class status (the sheet only had an ad hoc "Wrong Address" value in
-- its City Code dropdown with no reason/follow-up captured).
CREATE TABLE `shipments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `shopify_order_gid` VARCHAR(255) NOT NULL,
    `shopify_order_name` VARCHAR(64) NULL,
    `shopify_fulfillment_gid` VARCHAR(255) NULL,
    `conversation_id` INTEGER NULL,
    `contact_id` INTEGER NULL,
    `courier_type` ENUM('trax', 'leopards', 'postex', 'rocket') NOT NULL,
    `courier_credential_id` INTEGER NULL,
    `courier_tracking_number` VARCHAR(128) NULL,
    `courier_city_code` VARCHAR(32) NULL,
    `destination_city` VARCHAR(128) NULL,
    `destination_address` TEXT NULL,
    `status` ENUM('booked', 'in_transit', 'out_for_delivery', 'picked_up', 'ready_for_pickup', 'delivered', 'attempted', 'failed', 'address_issue', 'cancelled', 'returned') NOT NULL DEFAULT 'booked',
    `address_issue_reason` TEXT NULL,
    `address_issue_notified_at` DATETIME(3) NULL,
    `address_confirmed_at` DATETIME(3) NULL,
    `last_courier_status_raw` VARCHAR(128) NULL,
    `loadsheet_batch_id` INTEGER NULL,
    `booked_at` DATETIME(3) NULL,
    `delivered_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `booking_error` TEXT NULL,
    `raw_last_webhook` JSON NULL,
    `created_by_user_id` INTEGER NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shipments_company_id_shopify_order_gid_key`(`company_id`, `shopify_order_gid`),
    INDEX `shipments_company_id_status_idx`(`company_id`, `status`),
    INDEX `shipments_company_id_courier_type_status_loadsheet_batch_i_idx`(`company_id`, `courier_type`, `status`, `loadsheet_batch_id`),
    INDEX `shipments_courier_tracking_number_idx`(`courier_tracking_number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;

-- AddForeignKey
ALTER TABLE `shipments` ADD CONSTRAINT `shipments_loadsheet_batch_id_fkey` FOREIGN KEY (`loadsheet_batch_id`) REFERENCES `loadsheet_batches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
