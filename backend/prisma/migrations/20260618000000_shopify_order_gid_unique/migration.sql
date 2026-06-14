-- Engagement engine Phase 5: make a Shopify order's confirmation idempotent at
-- the DB level (Finding #24). First remove any duplicate tracking rows (keep the
-- earliest per company+order), then enforce uniqueness so a redelivered
-- orders/create webhook can never create a second confirmation row. Paired with
-- serial_key/dedup_key on the enqueue (prevents the duplicate being processed at
-- all) — this constraint is the DB backstop.
--
-- SAFE: the DELETE only removes already-duplicated rows (there should be none, or
-- a handful from past at-least-once redeliveries); it never touches sent messages
-- or orders. If the table has no duplicates the DELETE affects 0 rows.

DELETE t1 FROM `shopify_order_messages` t1
INNER JOIN `shopify_order_messages` t2
  ON t1.`company_id` = t2.`company_id`
  AND t1.`shopify_order_gid` = t2.`shopify_order_gid`
  AND t1.`id` > t2.`id`;

CREATE UNIQUE INDEX `shopify_order_messages_company_id_shopify_order_gid_key`
  ON `shopify_order_messages` (`company_id`, `shopify_order_gid`);
