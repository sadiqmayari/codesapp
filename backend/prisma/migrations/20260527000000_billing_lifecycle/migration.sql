-- Billing-Lifecycle: activation-anchored 30-day invoicing, auto-suspend,
-- and super-admin usage-limit policy.
-- MySQL 8 — NO `IF NOT EXISTS` on ADD COLUMN / CREATE TABLE.
-- One-time phpMyAdmin Import only. Re-running on a DB that already has
-- these fails with "Duplicate column name" / "Table already exists".
-- All company columns are additive + nullable.

ALTER TABLE companies ADD COLUMN activated_at        DATETIME(3) NULL;
ALTER TABLE companies ADD COLUMN suspended_at        DATETIME(3) NULL;
ALTER TABLE companies ADD COLUMN grace_until         DATETIME(3) NULL;
ALTER TABLE companies ADD COLUMN usage_limit_action  ENUM('block','warn_only') NULL;

-- Backfill: existing active companies get an anchor so the new
-- 30-day cycle has a stable origin (use their creation date).
UPDATE companies
   SET activated_at = created_at
 WHERE activation_status = 'active'
   AND activated_at IS NULL;

CREATE TABLE platform_settings (
  `key`      VARCHAR(64)  NOT NULL,
  `value`    VARCHAR(255) NOT NULL,
  updated_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`key`)
);

-- Seed the platform-wide default usage-limit action (= legacy behavior).
INSERT INTO platform_settings (`key`, `value`, updated_at)
VALUES ('usage_limit_action', 'block', CURRENT_TIMESTAMP(3));
