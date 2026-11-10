-- Attendance v3 — payroll + policy engine, flexible staff, `member` role.
-- MySQL/MariaDB — NO `IF NOT EXISTS`. One-time phpMyAdmin Import (or auto-applied
-- by `prisma migrate deploy` on container start) + redeploy WITH `npm install`
-- (Prisma client regen for the new columns/enum, else the backend 5xxs).
-- Additive + nullable only; existing rows unchanged.

-- 1) New Team-only role (additive enum value). Keep the full value list in order.
ALTER TABLE `users`
  MODIFY `role` ENUM(
    'super_admin', 'owner', 'admin', 'agent', 'finance', 'fulfillment',
    'content_manager', 'pr_manager', 'creative_executive',
    'social_media_executive', 'videographer', 'graphic_designer', 'member'
  ) NOT NULL;

-- 2) Per-user payroll + "flexible timing" flag.
ALTER TABLE `users`
  ADD COLUMN `attendance_exempt_late` TINYINT(1)    NOT NULL DEFAULT 0,
  ADD COLUMN `salary_amount`          DECIMAL(14,2) NULL,
  ADD COLUMN `salary_allowances`      JSON          NULL,
  ADD COLUMN `salary_overtime_rate`   DECIMAL(14,2) NULL;

-- 3) Per-tenant payroll policy (JSON blob) + check-in cutoff for the nudge bar.
ALTER TABLE `companies`
  ADD COLUMN `attendance_payroll_policy` JSON        NULL,
  ADD COLUMN `attendance_checkin_cutoff` VARCHAR(5)  NULL;
