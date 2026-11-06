-- Team attendance enhancements: per-user schedule + owner exclusion (code),
-- optional office-network (IP) lock, auto-absent/missed-checkout flags, and a
-- leave-requests workflow.
-- MySQL/MariaDB — NO `IF NOT EXISTS` by design. One-time phpMyAdmin Import.
-- Pair with a redeploy WITH `npm install` (Prisma client regen for the new
-- columns + model + LeaveRequestStatus enum, else the backend 5xxs).
-- Additive only.

-- Per-user schedule overrides + office-network enforcement toggle.
ALTER TABLE users
  ADD COLUMN attendance_work_start VARCHAR(5) NULL,
  ADD COLUMN attendance_work_end VARCHAR(5) NULL,
  ADD COLUMN attendance_require_office_ip TINYINT(1) NOT NULL DEFAULT 0;

-- Company general shift-end default + office network IP allow-list.
ALTER TABLE companies
  ADD COLUMN work_end_time VARCHAR(5) NULL,
  ADD COLUMN attendance_office_ips TEXT NULL;

-- Nightly-sweep flags on each attendance row.
ALTER TABLE attendance_records
  ADD COLUMN missed_checkout TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN system_marked TINYINT(1) NOT NULL DEFAULT 0;

-- Leave requests (member asks → owner/admin approve → auto-mark leave days).
CREATE TABLE attendance_leave_requests (
  id                  INT          NOT NULL AUTO_INCREMENT,
  company_id          INT          NOT NULL,
  user_id             INT          NOT NULL,
  from_date           DATE         NOT NULL,
  to_date             DATE         NOT NULL,
  reason              VARCHAR(500) NULL,
  status              ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  reviewed_by_user_id INT          NULL,
  reviewed_at         DATETIME(3)  NULL,
  review_note         VARCHAR(255) NULL,
  created_at          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX attendance_leave_requests_company_id_status_idx (company_id, status),
  INDEX attendance_leave_requests_company_id_user_id_idx (company_id, user_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
