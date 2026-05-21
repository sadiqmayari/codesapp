-- Saved canned / quick replies — company-wide reusable composer snippets.
-- MySQL 8 — NO `IF NOT EXISTS` on CREATE TABLE / CREATE INDEX here by design.
-- One-time phpMyAdmin Import only. Re-running on a DB that already has this
-- table fails with "Table 'canned_replies' already exists".
-- Additive only (new table, no change to existing tables, no backfill).
CREATE TABLE canned_replies (
  id          INT          NOT NULL AUTO_INCREMENT,
  company_id  INT          NOT NULL,
  title       VARCHAR(120) NOT NULL,
  body        TEXT         NOT NULL,
  created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX canned_replies_company_id_idx (company_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
