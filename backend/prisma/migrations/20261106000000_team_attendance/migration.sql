-- Team attendance: self check-in/out + admin override + report.
-- One row per user per tenant-local calendar day.
-- MySQL/MariaDB — NO `IF NOT EXISTS` by design.
-- One-time phpMyAdmin Import only; re-running on a DB that already has this
-- table fails with "Table 'attendance_records' already exists".
-- Pair with a redeploy WITH `npm install` (Prisma client regen for the new
-- model/column + the AttendanceStatus enum, else the backend 5xxs).
-- Additive only (new table + one new nullable column on companies).

-- Tenant work-start time "HH:MM" (24h, tenant-local via companies.timezone).
-- NULL → app default "09:30".
ALTER TABLE companies ADD COLUMN work_start_time VARCHAR(5) NULL;

CREATE TABLE attendance_records (
  id                INT          NOT NULL AUTO_INCREMENT,
  company_id        INT          NOT NULL,
  user_id           INT          NOT NULL,
  work_date         DATE         NOT NULL,
  status            ENUM('present','absent','leave','half_day','holiday') NOT NULL DEFAULT 'present',
  check_in_at       DATETIME(3)  NULL,
  check_out_at      DATETIME(3)  NULL,
  is_late           TINYINT(1)   NOT NULL DEFAULT 0,
  note              VARCHAR(255) NULL,
  marked_by_user_id INT          NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE INDEX attendance_records_company_id_user_id_work_date_key (company_id, user_id, work_date),
  INDEX attendance_records_company_id_work_date_idx (company_id, work_date)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
