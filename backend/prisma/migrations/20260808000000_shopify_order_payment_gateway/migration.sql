-- Payment-gateway capture for the Courier-payments split (Bank Deposit vs Card Payments).
-- `payment_gateway` = Shopify's payment gateway names (comma-joined), captured going
-- forward on every webhook + import upsert (no backfill by design).
-- `gateway_reconciled_at` = set when a Card-Payments order's gateway payout is reconciled.
ALTER TABLE `shopify_orders`
  ADD COLUMN `payment_gateway` VARCHAR(64) NULL AFTER `financial_status`,
  ADD COLUMN `gateway_reconciled_at` DATETIME(3) NULL AFTER `payment_gateway`;
