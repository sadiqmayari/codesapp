-- Attendance follow-ups (Nov-2026): Relaxed timing (never late), app lock after
-- shift end, auto-checkout credited by last activity. Additive only.
ALTER TABLE `users`
  ADD COLUMN `attendance_never_late` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `attendance_lock_after_shift` BOOLEAN NULL;
ALTER TABLE `companies`
  ADD COLUMN `attendance_lock_after_shift` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `attendance_lock_buffer_min` INT NULL;
ALTER TABLE `attendance_records`
  MODIFY `checkout_source` VARCHAR(16) NULL,
  ADD COLUMN `last_active_at` DATETIME(3) NULL;
