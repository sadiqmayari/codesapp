-- Order cancellation accounting (2026-07-20)
--
-- Cancelled / voided Shopify orders must stop counting toward agent order
-- counts and revenue, while the row REMAINS in the app as a record (shown in
-- the Orders list with a "Cancelled" badge).
--
-- Raw DDL, applied directly on prod: prod `prisma migrate deploy` is blocked by
-- a failed migration (P3009), so new columns go on via ALTER + raw read/write
-- and are NOT added to schema.prisma (same pattern as `order_total`).
--
-- Apply BEFORE deploying the code that reads these columns.
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < order-cancellation.sql

ALTER TABLE pending_order_hashes
  ADD COLUMN IF NOT EXISTS cancelled_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(24) NULL;

-- Counting queries filter `company_id = ? AND cancelled_at IS NULL`.
CREATE INDEX IF NOT EXISTS idx_poh_company_cancelled
  ON pending_order_hashes (company_id, cancelled_at);
