-- "Posted to ERP" marker on courier + PayFast statements (tenant records that the
-- statement was posted into their own ERP/accounting system).

ALTER TABLE `courier_invoices`
  ADD COLUMN `erp_posted_at` DATETIME(3) NULL,
  ADD COLUMN `erp_posted_by_user_id` INTEGER NULL;

ALTER TABLE `payment_settlements`
  ADD COLUMN `erp_posted_at` DATETIME(3) NULL,
  ADD COLUMN `erp_posted_by_user_id` INTEGER NULL;
