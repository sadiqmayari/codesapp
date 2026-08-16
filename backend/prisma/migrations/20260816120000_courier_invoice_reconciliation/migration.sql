-- Courier invoice reconciliation: the tenant uploads a courier's own settlement
-- statement (their COD remittance spreadsheet); we parse it, reconcile it against
-- our shipments, mark the paid parcels delivered + settled, and emit a branded PDF.
--
-- `courier_invoices` = one row per uploaded statement. `invoice_number` is the
-- COURIER's number (e.g. Rocket's 10098024); the UNIQUE on
-- (company_id, courier_type, invoice_number) is what stops the same statement
-- being uploaded/applied twice. `lines` / `summary` hold the parsed rows and the
-- per-line match result as a point-in-time audit artifact (JSON, never queried).
--
-- `shipments.courier_invoice_id` links a settled parcel to the statement that paid
-- it (written alongside the existing courier_settled_at).
CREATE TABLE `courier_invoices` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `company_id`         INT NOT NULL,
  `courier_type`       ENUM('trax', 'leopards', 'postex', 'rocket') NOT NULL,
  `invoice_number`     VARCHAR(64) NULL,
  `report_date`        DATETIME(3) NULL,
  `currency`           VARCHAR(8) NULL,
  `source_file_url`    VARCHAR(500) NULL,
  `pdf_url`            VARCHAR(500) NULL,
  `status`             VARCHAR(16) NOT NULL DEFAULT 'parsed',
  `total_rows`         INT NOT NULL DEFAULT 0,
  `paid_rows`          INT NOT NULL DEFAULT 0,
  `cod_collected`      DECIMAL(14,2) NULL,
  `deductions`         DECIMAL(14,2) NULL,
  `net_payable`        DECIMAL(14,2) NULL,
  `lines`              JSON NULL,
  `summary`            JSON NULL,
  `created_by_user_id` INT NULL,
  `applied_at`         DATETIME(3) NULL,
  `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3) NOT NULL,

  UNIQUE INDEX `courier_invoices_company_id_courier_type_invoice_number_key` (`company_id`, `courier_type`, `invoice_number`),
  INDEX `courier_invoices_company_id_created_at_idx` (`company_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `shipments`
  ADD COLUMN `courier_invoice_id` INT NULL AFTER `courier_settled_at`,
  ADD INDEX `shipments_courier_invoice_id_idx` (`courier_invoice_id`);

ALTER TABLE `shipments`
  ADD CONSTRAINT `shipments_courier_invoice_id_fkey`
  FOREIGN KEY (`courier_invoice_id`) REFERENCES `courier_invoices`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
