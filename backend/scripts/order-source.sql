-- Order source marker (2026-07-24)
--
-- Records WHERE an app-created order originated so abandoned-cart recoveries can
-- be counted separately from regular inbox/manual orders. Without this, the
-- "recovered via CodesApp" stat over-counted: ANY app order that merely matched
-- an abandoned cart (by phone/email/name) was credited as a recovery.
--
-- Values: 'abandoned_cart' (created from the Abandoned Checkouts "Create order"
-- button), 'inbox' (regular agent/AI order). NULL = legacy/unknown until the
-- one-time backfill (syncOrderSources, from Shopify's "Abandoned Checkout" tag)
-- classifies it.
--
-- Raw DDL, applied directly on prod (P3009 blocks migrate deploy); NOT in
-- schema.prisma. Apply BEFORE deploying the code that reads/writes it.
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < order-source.sql

ALTER TABLE pending_order_hashes
  ADD COLUMN IF NOT EXISTS source VARCHAR(24) NULL;

CREATE INDEX IF NOT EXISTS idx_poh_company_source
  ON pending_order_hashes (company_id, source);
