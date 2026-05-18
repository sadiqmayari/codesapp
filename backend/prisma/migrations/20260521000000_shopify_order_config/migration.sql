-- Shopify per-tenant order-confirmation — Phase 3.
-- Per-company config: which approved template to send on orders/create,
-- how to fill its {{n}} variables from Shopify order fields, and the
-- Confirm/Cancel order tag names.
--
-- One-time import (MySQL 8 — no CREATE TABLE IF NOT EXISTS guard needed,
-- but run exactly once via phpMyAdmin -> Import; re-running fails on
-- "table already exists").

CREATE TABLE `shopify_order_configs` (
  `id`            INT NOT NULL AUTO_INCREMENT,
  `company_id`    INT NOT NULL,
  `template_id`   INT NULL,
  `language_code` VARCHAR(16) NULL,
  `variable_map`  JSON NOT NULL,
  `confirm_tag`   VARCHAR(64) NOT NULL DEFAULT 'confirmed',
  `cancel_tag`    VARCHAR(64) NOT NULL DEFAULT 'cancelled',
  `enabled`       TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `shopify_order_configs_company_id_key` (`company_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
