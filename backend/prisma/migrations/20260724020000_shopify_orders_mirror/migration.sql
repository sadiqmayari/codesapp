-- Local mirror of Shopify orders, so the fulfilment queue can be listed,
-- filtered and bulk-selected without querying Shopify on every page load.
-- Additive: one new table, no changes to existing columns, no backfill
-- (the one-time import runs as a background job after deploy).
--
-- ANTI-DUPLICATION: UNIQUE(company_id, shopify_order_gid) is the single source
-- of order identity — the same key `shipments` and `shopify_order_messages`
-- already use. All three writers (CodesApp order creation, the orders/*
-- webhooks, and the one-time import) funnel through
-- ShopifyOrderSyncService.upsertOrder, so an order created in CodesApp and
-- then echoed back by the orders/create webhook UPDATES this row rather than
-- inserting a second one. The constraint — not application logic — is what
-- makes that hold under races, retries and webhook redeliveries.
--
-- FIELD OWNERSHIP: every column is Shopify-owned and refreshed on each sync
-- EXCEPT `assigned_user_id` / `internal_note` (CodesApp-owned, never
-- clobbered) and `source` (write-once first-touch provenance).
--
-- `total_outstanding` is what a COD courier must collect (0 once the order is
-- paid) — it replaces the hardcoded codAmount: 0 in the booking worker.
CREATE TABLE `shopify_orders` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `company_id` INTEGER NOT NULL,
    `shopify_order_gid` VARCHAR(255) NOT NULL,
    `order_name` VARCHAR(64) NULL,
    `order_number` VARCHAR(32) NULL,
    `fulfillment_order_gid` VARCHAR(255) NULL,
    `customer_name` VARCHAR(255) NULL,
    `phone` VARCHAR(32) NULL,
    `email` VARCHAR(255) NULL,
    `city` VARCHAR(128) NULL,
    `address1` TEXT NULL,
    `address2` TEXT NULL,
    `country_code` VARCHAR(8) NULL,
    `total_price` DECIMAL(12, 2) NULL,
    `total_outstanding` DECIMAL(12, 2) NULL,
    `currency` VARCHAR(8) NULL,
    `financial_status` VARCHAR(32) NULL,
    `fulfillment_status` VARCHAR(32) NULL,
    `line_items` JSON NULL,
    `line_items_summary` TEXT NULL,
    `shopify_created_at` DATETIME(3) NULL,
    `cancelled_at` DATETIME(3) NULL,
    `source` VARCHAR(16) NULL,
    `assigned_user_id` INTEGER NULL,
    `internal_note` TEXT NULL,
    `synced_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `shopify_orders_company_id_shopify_order_gid_key`(`company_id`, `shopify_order_gid`),
    INDEX `shopify_orders_company_id_fulfillment_status_cancelled_at_idx`(`company_id`, `fulfillment_status`, `cancelled_at`),
    INDEX `shopify_orders_company_id_shopify_created_at_idx`(`company_id`, `shopify_created_at`),
    INDEX `shopify_orders_company_id_order_name_idx`(`company_id`, `order_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4;
