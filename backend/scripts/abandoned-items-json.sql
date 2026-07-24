-- Structured abandoned-cart line items (2026-07-24)
--
-- Shopify's checkouts/create|update payload includes variant_id / price /
-- variant_title on each line item — we previously only kept a flat
-- "1x Title, 2x Title" string (items_summary), which can't be used to pre-fill
-- an order. Storing the structured lines lets the Create-order modal open with
-- the cart's exact products already in it (one-click recovery), and gives the
-- Items popover real per-line detail.
--
-- Shape: [{"variantId":"gid://shopify/ProductVariant/123","title":"…",
--          "variantTitle":"…","price":"1999.00","quantity":2}]
--
-- Raw DDL, applied directly on prod (P3009 blocks migrate deploy); NOT in
-- schema.prisma. Apply BEFORE deploying the code that reads it.
--   docker exec -i codesapp-mysql mariadb -uroot -p<pw> codes_app < abandoned-items-json.sql

ALTER TABLE shopify_abandoned_checkouts
  ADD COLUMN IF NOT EXISTS items_json LONGTEXT NULL;
