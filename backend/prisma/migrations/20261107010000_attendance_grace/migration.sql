-- Attendance grace period: minutes after shift start before a check-in is Late.
-- Company default + per-user override (null = fall back to company, then 0).
-- MySQL/MariaDB — NO `IF NOT EXISTS`. One-time phpMyAdmin Import + redeploy
-- WITH `npm install` (Prisma client regen). Additive only.
ALTER TABLE companies ADD COLUMN attendance_grace_minutes INT NULL;
ALTER TABLE users ADD COLUMN attendance_grace_minutes INT NULL;
