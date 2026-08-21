-- PayFast (payment-gateway) settlement reconciliation — the prepaid/online
-- counterpart of courier_invoices. The tenant uploads the gateway's transaction
-- export (+ optional settlement summary); we resolve each transaction to a
-- Shopify order via `gateway_payment_ref` (= PayFast paymentId = the file's
-- Order_Id), group into payout batches, and mark each order's gateway payout
-- reconciled. `batches`/`summary` hold the parsed + matched data as a JSON audit
-- artifact and the source of the consolidated branded statement.

CREATE TABLE `payment_settlements` (
  `id`                 INT NOT NULL AUTO_INCREMENT,
  `company_id`         INT NOT NULL,
  `gateway`            VARCHAR(24) NOT NULL,
  `merchant_id`        VARCHAR(64) NULL,
  `period_start`       DATETIME(3) NULL,
  `period_end`         DATETIME(3) NULL,
  `currency`           VARCHAR(8) NULL,
  `source_txn_url`     VARCHAR(500) NULL,
  `source_summary_url` VARCHAR(500) NULL,
  `pdf_url`            VARCHAR(500) NULL,
  `status`             VARCHAR(16) NOT NULL DEFAULT 'parsed',
  `total_txns`         INT NOT NULL DEFAULT 0,
  `matched_txns`       INT NOT NULL DEFAULT 0,
  `gross`              DECIMAL(14,2) NULL,
  `fees`               DECIMAL(14,2) NULL,
  `wht_st`             DECIMAL(14,2) NULL,
  `received`           DECIMAL(14,2) NULL,
  `batches`            JSON NULL,
  `summary`            JSON NULL,
  `created_by_user_id` INT NULL,
  `applied_at`         DATETIME(3) NULL,
  `created_at`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`         DATETIME(3) NOT NULL,

  UNIQUE INDEX `payment_settlements_dedup_key` (`company_id`, `gateway`, `period_start`, `period_end`),
  INDEX `payment_settlements_company_id_created_at_idx` (`company_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `shopify_orders`
  ADD COLUMN `gateway_payment_ref` VARCHAR(64) NULL AFTER `gateway_reconciled_at`,
  ADD COLUMN `payment_settlement_id` INT NULL AFTER `gateway_payment_ref`,
  ADD INDEX `shopify_orders_company_id_gateway_payment_ref_idx` (`company_id`, `gateway_payment_ref`),
  ADD INDEX `shopify_orders_payment_settlement_id_idx` (`payment_settlement_id`);

ALTER TABLE `shopify_orders`
  ADD CONSTRAINT `shopify_orders_payment_settlement_id_fkey`
  FOREIGN KEY (`payment_settlement_id`) REFERENCES `payment_settlements`(`id`)
  ON DELETE SET NULL ON UPDATE CASCADE;
