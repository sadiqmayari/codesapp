-- 20260601000000_company_timezone
--
-- Per-tenant timezone (IANA name, e.g. "Asia/Karachi", "Europe/London").
-- Frontend date/time formatters read this so dd/MMM/YYYY · HH:MM renders
-- in the tenant's own clock, not the viewer's browser clock. NULL = fall
-- back to the browser's timezone (Intl default).
--
-- Additive nullable column — no backfill. MySQL 8, no IF NOT EXISTS.
-- Pair with redeploy WITH `npm install` (Prisma client regen).

ALTER TABLE companies
  ADD COLUMN timezone VARCHAR(64) NULL;
