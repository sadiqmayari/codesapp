-- Multi-step abandoned-cart recovery sequence.
--
-- Additive JSON column on shopify_order_configs holding an ordered list of
-- recovery steps: [{ "delayMinutes": 60, "templateId": 12, "variableMap": {} }, ...].
-- When present + non-empty it REPLACES the single-template behaviour; when empty
-- the legacy single recovery (abandoned_cart event template + delay) is used, so
-- this is fully backward compatible.
--
-- Raw DDL (prod migrate deploy blocked, P3009) + raw read/write — NOT in
-- schema.prisma. Apply ONCE on prod before deploy. Idempotent.

ALTER TABLE `shopify_order_configs`
  ADD COLUMN IF NOT EXISTS `abandoned_cart_steps` JSON NULL;
