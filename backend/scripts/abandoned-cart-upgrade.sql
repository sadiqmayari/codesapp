-- Abandoned-cart upgrade: cart value + recovery-outcome tracking.
--
-- Additive columns on the existing shopify_abandoned_checkouts table. Applied
-- as RAW DDL directly on prod (prod migrate deploy is blocked by P3009) and
-- accessed via $queryRawUnsafe/$executeRawUnsafe — these columns are NOT added
-- to schema.prisma (same pattern as pending_order_hashes.order_total), so the
-- typed base-row calls keep working and the new columns are read/written raw.
--
-- Apply ONCE on prod BEFORE deploying the new code:
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < abandoned-cart-upgrade.sql
-- Idempotent (ADD COLUMN IF NOT EXISTS) — safe to re-run.

ALTER TABLE `shopify_abandoned_checkouts`
  ADD COLUMN IF NOT EXISTS `total_price`          DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS `currency`             VARCHAR(8)    NULL,
  ADD COLUMN IF NOT EXISTS `recovery_sent_at`     DATETIME(3)   NULL,
  ADD COLUMN IF NOT EXISTS `converted_order_gid`  VARCHAR(64)   NULL,
  ADD COLUMN IF NOT EXISTS `converted_value`      DECIMAL(14,2) NULL,
  ADD COLUMN IF NOT EXISTS `converted_at`         DATETIME(3)   NULL;

-- Helps the stats/recovery queries filter by outcome quickly.
CREATE INDEX IF NOT EXISTS `shopify_abandoned_recovery_idx`
  ON `shopify_abandoned_checkouts` (`company_id`, `recovery_sent_at`);
