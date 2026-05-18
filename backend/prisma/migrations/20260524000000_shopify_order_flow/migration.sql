-- Shopify order-confirmation flow hardening.
--  * companies.default_country_code — for normalizing Shopify phone numbers
--    (e.g. local 0317… → 92317…) so they de-dupe against existing contacts.
--  * shopify_order_configs.pending_tag — tag applied if the customer doesn't
--    answer within the decision window (client-configurable).
--  * shopify_order_configs.decision_window_minutes — that window (default 2).
--
-- One-time import (MySQL 8 — no IF NOT EXISTS). Run once via phpMyAdmin
-- -> Import. Re-running fails on duplicate column.

ALTER TABLE `companies` ADD COLUMN `default_country_code` VARCHAR(8) NULL;

ALTER TABLE `shopify_order_configs`
  ADD COLUMN `pending_tag` VARCHAR(64) NULL;
ALTER TABLE `shopify_order_configs`
  ADD COLUMN `decision_window_minutes` INT NULL;
