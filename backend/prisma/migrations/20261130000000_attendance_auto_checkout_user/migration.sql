-- Per-member auto-checkout override (NULL = follow the company setting).
ALTER TABLE `users` ADD COLUMN `attendance_auto_checkout` BOOLEAN NULL;
