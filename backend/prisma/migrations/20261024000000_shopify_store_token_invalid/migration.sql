-- Track a Shopify store whose Admin API token was rejected (401 / revoked at
-- source), so the UI can prompt a reconnect. Additive, nullable.
ALTER TABLE `shopify_stores` ADD COLUMN `token_invalid_at` DATETIME(3) NULL;
