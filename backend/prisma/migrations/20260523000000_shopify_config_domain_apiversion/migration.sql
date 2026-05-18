-- Shopify per-tenant — Phase 4b. Configurable store domain (fallback /
-- explicit, used when the webhook's X-Shopify-Shop-Domain header is absent)
-- and a selectable Shopify Admin API version (per quarterly releases).
--
-- One-time import (MySQL 8 — no IF NOT EXISTS). Run once via phpMyAdmin
-- -> Import. Re-running fails on duplicate column.

ALTER TABLE `shopify_order_configs`
  ADD COLUMN `shop_domain` VARCHAR(255) NULL;
ALTER TABLE `shopify_order_configs`
  ADD COLUMN `api_version` VARCHAR(16) NULL;
