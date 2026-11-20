-- Team module v4 (Nov-2026). Additive only — no existing data is changed.
--  * auto-checkout policy + flexible staff required hours
--  * work calendar (weekly off days + holidays), joined/left dates, paid leave quota
--  * leave/correction requests (kind, paid, leave type, requested times)
--  * payroll runs (draft -> approved -> paid, locked snapshot) + adjustments
--  * commissions: one order-attribution ledger + configurable commission plans
--  * pack station: shipments.packed_by_user_id / packed_at

ALTER TABLE `companies`
  ADD COLUMN `attendance_auto_checkout` JSON NULL,
  ADD COLUMN `attendance_weekly_off` JSON NULL,
  ADD COLUMN `attendance_annual_paid_leave` INTEGER NULL;

ALTER TABLE `users`
  ADD COLUMN `attendance_required_minutes` INTEGER NULL,
  ADD COLUMN `attendance_weekly_off` JSON NULL,
  ADD COLUMN `joined_on` DATE NULL,
  ADD COLUMN `left_on` DATE NULL,
  ADD COLUMN `annual_paid_leave` INTEGER NULL;

ALTER TABLE `attendance_records`
  ADD COLUMN `checkout_source` VARCHAR(8) NULL;

ALTER TABLE `attendance_leave_requests`
  ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'leave',
  ADD COLUMN `paid` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `leave_type` VARCHAR(16) NULL,
  ADD COLUMN `req_check_in` VARCHAR(5) NULL,
  ADD COLUMN `req_check_out` VARCHAR(5) NULL;

ALTER TABLE `shipments`
  ADD COLUMN `packed_by_user_id` INTEGER NULL,
  ADD COLUMN `packed_at` DATETIME(3) NULL,
  ADD INDEX `shipments_company_id_packed_at_idx` (`company_id`, `packed_at`);

CREATE TABLE `attendance_holidays` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `date` DATE NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `attendance_holidays_company_id_date_key` (`company_id`, `date`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `payroll_runs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `status` VARCHAR(12) NOT NULL DEFAULT 'draft',
  `policy_snapshot` JSON NULL,
  `totals` JSON NULL,
  `created_by_user_id` INTEGER NULL,
  `approved_by_user_id` INTEGER NULL,
  `approved_at` DATETIME(3) NULL,
  `paid_by_user_id` INTEGER NULL,
  `paid_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `payroll_runs_company_id_month_key` (`company_id`, `month`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `payroll_run_lines` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `run_id` INTEGER NOT NULL,
  `company_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `snapshot` JSON NOT NULL,
  `gross` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `deductions` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `commission` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  `net` DECIMAL(14, 2) NOT NULL DEFAULT 0,
  UNIQUE INDEX `payroll_run_lines_run_id_user_id_key` (`run_id`, `user_id`),
  INDEX `payroll_run_lines_company_id_user_id_idx` (`company_id`, `user_id`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `payroll_adjustments` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `month` VARCHAR(7) NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `label` VARCHAR(120) NOT NULL,
  `amount` DECIMAL(14, 2) NOT NULL,
  `note` VARCHAR(255) NULL,
  `created_by_user_id` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `payroll_adjustments_company_id_month_idx` (`company_id`, `month`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `order_attributions` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `order_gid` VARCHAR(255) NOT NULL,
  `order_name` VARCHAR(64) NULL,
  `kind` VARCHAR(24) NOT NULL,
  `user_id` INTEGER NOT NULL,
  `source` VARCHAR(24) NULL,
  `value` DECIMAL(14, 2) NULL,
  `at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `order_attributions_company_id_order_gid_kind_key` (`company_id`, `order_gid`, `kind`),
  INDEX `order_attributions_company_id_kind_at_idx` (`company_id`, `kind`, `at`),
  INDEX `order_attributions_company_id_user_id_kind_idx` (`company_id`, `user_id`, `kind`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `commission_plans` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `metric` VARCHAR(32) NOT NULL,
  `config` JSON NOT NULL,
  `applies_to` JSON NOT NULL,
  `created_by_user_id` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `commission_plans_company_id_active_idx` (`company_id`, `active`),
  PRIMARY KEY (`id`)
);
