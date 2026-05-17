-- Option B: per-tenant Meta app secret + webhook verify token + unique
-- callback key. One-time import (MySQL 8 has no ADD COLUMN IF NOT EXISTS);
-- run exactly once via phpMyAdmin → Import. NULL columns fall back to the
-- platform META_VERIFY_TOKEN / META_APP_SECRET env (Tech-Provider path).

ALTER TABLE `companies`
  ADD COLUMN `webhook_key` VARCHAR(160) NULL,
  ADD COLUMN `webhook_app_secret_encrypted` TEXT NULL,
  ADD COLUMN `webhook_verify_token` VARCHAR(255) NULL;

CREATE UNIQUE INDEX `companies_webhook_key_key` ON `companies`(`webhook_key`);
