-- Plan public-pricing fields (landing-page pricing cards, super-admin controlled).
-- One-time phpMyAdmin Import (MySQL 8, no IF NOT EXISTS — re-run fails on dup column).
-- Pair with redeploy WITH `npm install` (Prisma client regen for the new fields).
-- All additive + defaulted so existing rows/queries are unaffected; plans stay
-- hidden from the public pricing section until `is_public` is turned on.

ALTER TABLE `subscriptions` ADD COLUMN `is_public`      BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE `subscriptions` ADD COLUMN `display_order`  INT         NOT NULL DEFAULT 0;
ALTER TABLE `subscriptions` ADD COLUMN `is_highlighted` BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE `subscriptions` ADD COLUMN `tagline`        VARCHAR(160) NULL;
ALTER TABLE `subscriptions` ADD COLUMN `features`       JSON         NULL;
ALTER TABLE `subscriptions` ADD COLUMN `cta_label`      VARCHAR(40)  NULL;
ALTER TABLE `subscriptions` ADD COLUMN `currency`       VARCHAR(8)  NOT NULL DEFAULT 'PKR';
ALTER TABLE `subscriptions` ADD COLUMN `billing_period` VARCHAR(16) NOT NULL DEFAULT 'month';
