-- Dashboard v3: per-user widget layout + the owner/admin team default.
ALTER TABLE `users` ADD COLUMN `dashboard_layout` JSON NULL;
ALTER TABLE `companies` ADD COLUMN `dashboard_default` JSON NULL;
