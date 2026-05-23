-- 20260531000000_company_overrides_and_warnings
--
-- Phase 4 — Enterprise plan + per-client editable limit overrides.
-- Phase 4.5 — 90/99/100% usage-limit notifications (fire-once ledger).
--
-- Additive only — no backfill needed (all four columns are nullable).
-- MySQL 8 — re-run will fail on duplicate column (no IF NOT EXISTS).
-- Pair with redeploy WITH `npm install` (Prisma client regen).

ALTER TABLE companies
  ADD COLUMN contact_limit_override  INT NULL,
  ADD COLUMN template_limit_override INT NULL,
  ADD COLUMN user_limit_override     INT NULL;

ALTER TABLE usage_metering
  ADD COLUMN thresholds_notified JSON NULL;
