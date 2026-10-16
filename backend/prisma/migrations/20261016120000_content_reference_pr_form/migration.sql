-- Content reference media + redesigned PR submission form fields.
-- MySQL 8 — one-time phpMyAdmin Import. Additive.

ALTER TABLE `content_items`
  ADD COLUMN `reference_drive_file_id` VARCHAR(128) NULL,
  ADD COLUMN `reference_media_type`    VARCHAR(16)  NULL;

ALTER TABLE `pr_campaigns`
  ADD COLUMN `terms` TEXT NULL;

ALTER TABLE `pr_submissions`
  ADD COLUMN `form_data` JSON NULL;
