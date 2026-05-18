-- FE Shopify per-tenant order-confirmation feature (Phase 1).
-- Mirrors Meta Option B: each client uses their OWN Shopify (custom) app
-- and configures a webhook to a unique per-tenant URL
-- /webhooks/shopify/{shopify_webhook_key}; the client's Shopify webhook
-- signing secret is stored encrypted (AES-256-GCM) for HMAC verification.
--
-- One-time import (MySQL 8 has NO `ADD COLUMN IF NOT EXISTS`). Run exactly
-- once via phpMyAdmin -> Import. Re-running fails on duplicate column /
-- duplicate index `companies_shopify_webhook_key_key`.

ALTER TABLE `companies` ADD COLUMN `shopify_webhook_key` VARCHAR(160) NULL;
ALTER TABLE `companies` ADD COLUMN `shopify_webhook_secret_encrypted` TEXT NULL;

CREATE UNIQUE INDEX `companies_shopify_webhook_key_key`
  ON `companies`(`shopify_webhook_key`);
