-- Ticket-driven replacement shipments (Option A): a replacement is a REAL
-- shipment row so it inherits status-sync, the tracking view, label/loadsheet
-- download and courier-invoice reconciliation for free. Three additive columns,
-- no change to the existing `@@unique([company_id, shopify_order_gid])` — a
-- replacement is stored under a suffixed gid (e.g. "<gid>#R1") while
-- `original_order_gid` keeps the link back to the real order for grouping.

ALTER TABLE `shipments`
  ADD COLUMN `is_replacement` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `original_order_gid` VARCHAR(255) NULL,
  ADD COLUMN `replacement_of_ticket_id` INTEGER NULL;

-- Find a ticket's replacement parcels, and group replacements under their order.
CREATE INDEX `shipments_replacement_of_ticket_id_idx` ON `shipments` (`replacement_of_ticket_id`);
CREATE INDEX `shipments_company_id_original_order_gid_idx` ON `shipments` (`company_id`, `original_order_gid`);
