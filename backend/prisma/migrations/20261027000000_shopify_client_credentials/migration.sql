-- Shopify client-credentials auth mode (Dev Dashboard apps).
-- Additive + nullable: every existing store defaults to 'legacy' (the current
-- permanent admin-token behaviour), so nothing changes until a store is
-- explicitly switched to 'client_credentials'. The minted ~24h token is cached
-- in-process only and is NEVER stored in these columns.
ALTER TABLE `shopify_stores`
  ADD COLUMN `auth_mode` VARCHAR(20) NOT NULL DEFAULT 'legacy',
  ADD COLUMN `client_id_encrypted` TEXT NULL,
  ADD COLUMN `client_secret_encrypted` TEXT NULL;
