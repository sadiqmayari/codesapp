-- Content + PR module feature flags and the per-tenant Google Drive
-- connection columns. MySQL 8 — NO `IF NOT EXISTS` by design (one-time
-- phpMyAdmin Import). Additive only (no backfill; all default off / NULL).

-- Plan gates (what the tier includes).
ALTER TABLE `subscriptions`
  ADD COLUMN `content_enabled` TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN `pr_enabled`      TINYINT(1) NOT NULL DEFAULT 0;

-- Tenant toggles + Google Drive OAuth connection (refresh token encrypted at
-- rest; content media lives in the tenant's own Drive under gdrive_folder_id).
ALTER TABLE `companies`
  ADD COLUMN `content_enabled`                TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN `pr_enabled`                     TINYINT(1)   NOT NULL DEFAULT 0,
  ADD COLUMN `gdrive_refresh_token_encrypted` TEXT         NULL,
  ADD COLUMN `gdrive_email`                   VARCHAR(255) NULL,
  ADD COLUMN `gdrive_folder_id`               VARCHAR(128) NULL,
  ADD COLUMN `gdrive_connected_at`            DATETIME(3)  NULL;
