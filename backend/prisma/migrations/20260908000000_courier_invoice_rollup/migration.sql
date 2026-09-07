-- Monthly rollup statements: consolidate a courier's month of settlement
-- statements into one saved statement (excluded from reconciliation/apply).
ALTER TABLE `courier_invoices`
  ADD COLUMN `is_rollup` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `period` VARCHAR(7) NULL,
  ADD COLUMN `source_invoice_ids` JSON NULL;
