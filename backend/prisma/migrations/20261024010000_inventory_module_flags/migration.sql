-- Inventory module feature flags + the cached Shopify primary location used as
-- the target for quantity pushes. MySQL 8 — NO `IF NOT EXISTS` by design
-- (one-time phpMyAdmin Import). Additive only (all default off / true / NULL).

-- Tenant toggles. inventory_enabled = the merchant sees Inventory (super-admin
-- granted, like Content/PR). inventory_restock_returns = auto-restock + push to
-- Shopify when an RTO parcel is physically received (default on).
ALTER TABLE `companies`
  ADD COLUMN `inventory_enabled`         TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `inventory_restock_returns` TINYINT(1) NOT NULL DEFAULT 1;

-- Cached primary location GID (gid://shopify/Location/..) for inventorySetQuantities.
ALTER TABLE `shopify_stores`
  ADD COLUMN `primary_location_gid` VARCHAR(120) NULL;
