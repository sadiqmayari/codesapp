-- Contacts 360: marketing consent (opt-out) + list/filter indexes. Additive.
ALTER TABLE `contacts`
  ADD COLUMN `opted_out_at` DATETIME(3) NULL,
  ADD COLUMN `opt_out_source` VARCHAR(32) NULL;

CREATE INDEX `contacts_company_id_deleted_at_status_idx` ON `contacts`(`company_id`, `deleted_at`, `status`);
CREATE INDEX `contacts_company_id_last_message_at_idx` ON `contacts`(`company_id`, `last_message_at`);
