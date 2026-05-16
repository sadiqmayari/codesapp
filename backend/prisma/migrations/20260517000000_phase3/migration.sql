-- CodesApp — Phase 3 migration
-- Run ONCE on Hostinger via phpMyAdmin → Import (prisma migrate is unavailable on Hostinger).
-- Additive only. MySQL 8 does NOT support `ADD COLUMN IF NOT EXISTS` — re-running
-- this file on a DB that already has these columns will fail with "Duplicate column".

-- ─── Alter: invoices — billing metadata columns ──────────────────────────────
ALTER TABLE `invoices`
  ADD COLUMN `invoice_number` VARCHAR(32) NULL,
  ADD COLUMN `period` VARCHAR(7) NULL,
  ADD COLUMN `description` TEXT NULL,
  ADD COLUMN `plan_snapshot` JSON NULL;

CREATE UNIQUE INDEX `idx_invoices_number` ON `invoices`(`invoice_number`);
CREATE INDEX `idx_invoices_company_period` ON `invoices`(`company_id`, `period`);

-- ─── Index: webhook_logs — log filter performance ────────────────────────────
CREATE INDEX `idx_webhook_logs_endpoint_status`
  ON `webhook_logs`(`webhook_id`, `delivery_status`, `created_at` DESC);

-- ─── Index: messages media cleanup ───────────────────────────────────────────
-- The Phase 1 init migration (20260515000000_init) already created
-- `messages_media_expires_at_media_expired_idx` from the schema.prisma
-- @@index([media_expires_at, media_expired]). Run `SHOW INDEX FROM messages;`
-- first. If that index is present (it is, on the production DB), leave the
-- line below commented out. Only uncomment on a DB that lacks it.
-- CREATE INDEX `idx_messages_media_expires` ON `messages`(`media_expires_at`, `media_expired`);
