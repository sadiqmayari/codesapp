-- Multi-Store — Phase 1 backfill. Creates ONE primary shopify_stores row per
-- company that already has a Shopify connection, then stamps the existing
-- order/fulfilment/finance rows + the order-config to that store. Idempotent
-- (INSERT ... WHERE NOT EXISTS; UPDATEs only touch NULL stamps).
--
-- The store's webhook_key is COALESCE(companies.shopify_webhook_key, generated)
-- so an already-registered Shopify callback keeps routing (now to the store);
-- a company with no key gets a fresh unique one. The encrypted admin token /
-- webhook secret are copied verbatim (same EncryptionService key → still
-- decryptable). Companies with no token+domain are skipped (nothing to connect).

INSERT INTO `shopify_stores`
  (`company_id`, `label`, `shop_domain`, `api_version`, `admin_token_encrypted`,
   `webhook_key`, `webhook_secret_encrypted`, `active_events`, `status`,
   `is_primary`, `created_at`, `updated_at`)
SELECT
  c.id,
  NULL,
  COALESCE(oc.shop_domain, si.shop_domain),
  oc.api_version,
  COALESCE(c.shopify_admin_token_encrypted, si.access_token_encrypted),
  COALESCE(c.shopify_webhook_key, CONCAT('sh-', REPLACE(UUID(), '-', ''))),
  COALESCE(c.shopify_webhook_secret_encrypted, si.webhook_secret_encrypted),
  COALESCE(si.active_events, JSON_ARRAY()),
  'active',
  1,
  NOW(3),
  NOW(3)
FROM `companies` c
LEFT JOIN `shopify_order_configs` oc ON oc.company_id = c.id
LEFT JOIN `shopify_integrations` si ON si.company_id = c.id
WHERE COALESCE(c.shopify_admin_token_encrypted, si.access_token_encrypted) IS NOT NULL
  AND COALESCE(oc.shop_domain, si.shop_domain) IS NOT NULL
  AND TRIM(COALESCE(oc.shop_domain, si.shop_domain)) <> ''
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
