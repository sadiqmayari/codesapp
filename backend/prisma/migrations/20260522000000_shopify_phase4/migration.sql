-- Shopify per-tenant order-confirmation — Phase 4 (send + tag-back).
-- Adds the client's Admin API access token (encrypted) used to tag the
-- order when the customer taps Confirm/Cancel, and a link table from our
-- outbound template message -> the Shopify order.
--
-- One-time import (MySQL 8 — no IF NOT EXISTS). Run exactly once via
-- phpMyAdmin -> Import. Re-running fails on duplicate column / table exists.

ALTER TABLE `companies` ADD COLUMN `shopify_admin_token_encrypted` TEXT NULL;

CREATE TABLE `shopify_order_messages` (
  `id`                INT NOT NULL AUTO_INCREMENT,
  `company_id`        INT NOT NULL,
  `message_id`        INT NOT NULL,
  `conversation_id`   INT NOT NULL,
  `shopify_order_gid` VARCHAR(255) NOT NULL,
  `shop_domain`       VARCHAR(255) NOT NULL,
  `status`            VARCHAR(16) NOT NULL DEFAULT 'pending',
  `created_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `shopify_order_messages_message_id_key` (`message_id`),
  KEY `shopify_order_messages_company_id_idx` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
