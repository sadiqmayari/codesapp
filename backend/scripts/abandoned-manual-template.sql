-- Manual abandoned-cart message template (2026-07-24)
--
-- Powers the per-row "Send message" button on Orders → Abandoned Checkouts.
-- Deliberately SEPARATE from the automated abandoned_cart recovery sequence
-- (delivery_notifications / abandoned_cart_steps) so a tenant can message a
-- cart by hand without enabling any automation.
--
-- Shape: {"templateId": 123, "variableMap": {"1": "customer_name", ...}}
--
-- Raw DDL, applied directly on prod (P3009 blocks migrate deploy); NOT in
-- schema.prisma. Apply BEFORE deploying the code that reads it.
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < abandoned-manual-template.sql

ALTER TABLE shopify_order_configs
  ADD COLUMN IF NOT EXISTS abandoned_manual_template LONGTEXT NULL;
