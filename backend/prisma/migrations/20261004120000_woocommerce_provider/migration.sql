-- WooCommerce integration — make the commerce-store plumbing provider-aware.
-- Additive + backward-compatible: every existing row is Shopify, so `provider`
-- defaults to 'shopify' and all existing behavior is unchanged. The table/column
-- names keep the `shopify_` prefix as the generic "commerce store" identity so
-- the mirror/couriers/finance stamps (shopify_store_id / shopify_order_gid) stay
-- intact; a Woo order's shopify_order_gid holds a synthetic `woo://{storeId}/{id}`.

-- 1) Stores become provider-aware. Woo rows use base_url + wc_* creds; Shopify
--    rows keep shop_domain + admin_token_encrypted. admin_token stays NOT NULL
--    (a Woo row stores '' there) so ShopifyService internals keep their types.
ALTER TABLE `shopify_stores`
  ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT 'shopify',
  ADD COLUMN `base_url` VARCHAR(255) NULL,
  ADD COLUMN `wc_consumer_key_encrypted` TEXT NULL,
  ADD COLUMN `wc_consumer_secret_encrypted` TEXT NULL;

-- 2) The orders mirror records which provider owns each order.
ALTER TABLE `shopify_orders`
  ADD COLUMN `provider` VARCHAR(16) NOT NULL DEFAULT 'shopify';
