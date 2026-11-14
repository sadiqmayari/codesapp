-- Growth ad management: editable settings on ad_entities + change log + drafts. Additive.
ALTER TABLE `ad_entities`
  ADD COLUMN `configured_status` VARCHAR(16) NULL,
  ADD COLUMN `budget_owner` VARCHAR(8) NULL,
  ADD COLUMN `budget_type` VARCHAR(8) NULL,
  ADD COLUMN `lifetime_budget` DECIMAL(14, 2) NULL,
  ADD COLUMN `bid_strategy` VARCHAR(40) NULL,
  ADD COLUMN `bid_amount` DECIMAL(14, 2) NULL,
  ADD COLUMN `roas_floor` DECIMAL(8, 4) NULL,
  ADD COLUMN `optimization_goal` VARCHAR(40) NULL,
  ADD COLUMN `conversion_event` VARCHAR(40) NULL,
  ADD COLUMN `destination_type` VARCHAR(32) NULL,
  ADD COLUMN `attribution_spec` JSON NULL,
  ADD COLUMN `start_time` DATETIME(3) NULL,
  ADD COLUMN `end_time` DATETIME(3) NULL;

CREATE TABLE `ad_change_log` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `account_id` INT NOT NULL,
  `user_id` INT NULL,
  `user_name` VARCHAR(255) NULL,
  `platform` VARCHAR(16) NOT NULL,
  `level` VARCHAR(8) NOT NULL,
  `entity_id` VARCHAR(64) NOT NULL,
  `entity_name` VARCHAR(512) NULL,
  `action` VARCHAR(24) NOT NULL,
  `before` JSON NULL,
  `after` JSON NULL,
  `batch_id` VARCHAR(40) NOT NULL,
  `result` VARCHAR(12) NOT NULL DEFAULT 'pending',
  `error` VARCHAR(1000) NULL,
  `undo_of_id` INT NULL,
  `undone_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `ad_change_log_company_id_created_at_idx`(`company_id`, `created_at`),
  INDEX `ad_change_log_company_id_entity_id_idx`(`company_id`, `entity_id`),
  INDEX `ad_change_log_batch_id_idx`(`batch_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ad_drafts` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `user_id` INT NOT NULL,
  `payload` JSON NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `ad_drafts_company_id_user_id_key`(`company_id`, `user_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
