-- Multi-Store — Phase 1 backfill. Creates ONE primary shopify_stores row per
-- company that already has a Shopify connection, then stamps the existing
-- order/fulfilment/finance rows + the order-config to that store. Idempotent
-- (INSERT ... WHERE NOT EXISTS; UPDATEs only touch NULL stamps).
--
-- COLLATION NOTE: the source string columns mix collations (older tables are
-- utf8mb4_unicode_ci, newer ones created under MariaDB 11.4 are
-- utf8mb4_uca1400_ai_ci), and string literals / UUID() take the connection
-- default. Mixing them in COALESCE / <> throws error 1267, so every string
-- expression below is pinned to utf8mb4_unicode_ci (the target table's
-- collation) with explicit COLLATE.

INSERT INTO `shopify_stores`
  (`company_id`, `label`, `shop_domain`, `api_version`, `admin_token_encrypted`,
   `webhook_key`, `webhook_secret_encrypted`, `active_events`, `status`,
   `is_primary`, `created_at`, `updated_at`)
SELECT
  c.id,
  NULL,
  COALESCE(oc.shop_domain COLLATE utf8mb4_unicode_ci, si.shop_domain COLLATE utf8mb4_unicode_ci),
  oc.api_version COLLATE utf8mb4_unicode_ci,
  COALESCE(c.shopify_admin_token_encrypted COLLATE utf8mb4_unicode_ci, si.access_token_encrypted COLLATE utf8mb4_unicode_ci),
  COALESCE(c.shopify_webhook_key COLLATE utf8mb4_unicode_ci, CONCAT('sh-', REPLACE(UUID(), '-', '')) COLLATE utf8mb4_unicode_ci),
  COALESCE(c.shopify_webhook_secret_encrypted COLLATE utf8mb4_unicode_ci, si.webhook_secret_encrypted COLLATE utf8mb4_unicode_ci),
  COALESCE(si.active_events, JSON_ARRAY()),
  'active',
  1,
  NOW(3),
  NOW(3)
FROM `companies` c
LEFT JOIN `shopify_order_configs` oc ON oc.company_id = c.id
LEFT JOIN `shopify_integrations` si ON si.company_id = c.id
WHERE COALESCE(c.shopify_admin_token_encrypted COLLATE utf8mb4_unicode_ci, si.access_token_encrypted COLLATE utf8mb4_unicode_ci) IS NOT NULL
  AND COALESCE(oc.shop_domain COLLATE utf8mb4_unicode_ci, si.shop_domain COLLATE utf8mb4_unicode_ci) IS NOT NULL
  AND TRIM(COALESCE(oc.shop_domain COLLATE utf8mb4_unicode_ci, si.shop_domain COLLATE utf8mb4_unicode_ci)) <> ''
  AND NOT EXISTS (SELECT 1 FROM `shopify_stores` s WHERE s.company_id = c.id);

-- Point the 1:1 order-config at its store.
UPDATE `shopify_order_configs` oc
JOIN `shopify_stores` s ON s.company_id = oc.company_id AND s.is_primary = 1
SET oc.shopify_store_id = s.id
WHERE oc.shopify_store_id IS NULL;

-- Stamp existing rows to the company's (single) primary store.
UPDATE `shopify_orders` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;

UPDATE `shopify_order_messages` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;

UPDATE `shopify_abandoned_checkouts` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;

UPDATE `shipments` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;

UPDATE `courier_invoices` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;

UPDATE `payment_settlements` t
JOIN `shopify_stores` s ON s.company_id = t.company_id AND s.is_primary = 1
SET t.shopify_store_id = s.id WHERE t.shopify_store_id IS NULL;
