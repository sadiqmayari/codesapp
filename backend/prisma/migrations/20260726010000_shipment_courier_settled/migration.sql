-- Courier payment reconciliation: when the tenant marks a delivered shipment's
-- COD as remitted/paid by the courier. NULL = still receivable (pending).
ALTER TABLE `shipments`
  ADD COLUMN `courier_settled_at` DATETIME(3) NULL;

CREATE INDEX `shipments_company_id_status_courier_settled_at_idx`
  ON `shipments` (`company_id`, `status`, `courier_settled_at`);
