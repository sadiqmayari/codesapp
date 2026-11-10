-- Attendance v3 fix — per-user check-in cutoff. The check-in window is now
-- measured in minutes AFTER each user's own shift start (default 150 = 2.5h, so
-- a 09:30 shift still closes at 12:00), so staff on different shifts each get
-- their own cutoff instead of a single company-wide absolute time. Flexible
-- (exempt) staff get no cutoff. Additive + nullable; auto-applies on container
-- start (redeploy regenerates the Prisma client). The old absolute
-- `attendance_checkin_cutoff` column is left dormant (no destructive drop).
ALTER TABLE `companies`
  ADD COLUMN `attendance_checkin_window_minutes` INT NULL;
