-- Per-variant Shopify push outcome, surfaced on the Inventory board.
-- status ∈ pending|ok|error|skipped ; error holds the last failure message
-- (e.g. "...needs write_inventory"). qty_* = inventorySetQuantities push,
-- cost_* = inventoryItemUpdate (cost-per-item) push. All additive + nullable.
ALTER TABLE `inventory_variants`
  ADD COLUMN `qty_push_status`  VARCHAR(12)  NULL,
  ADD COLUMN `qty_push_error`   VARCHAR(500) NULL,
  ADD COLUMN `cost_push_status` VARCHAR(12)  NULL,
  ADD COLUMN `cost_push_error`  VARCHAR(500) NULL;
