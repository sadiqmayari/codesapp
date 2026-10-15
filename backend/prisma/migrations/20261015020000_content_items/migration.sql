-- Content module tables. MySQL 8 — NO `IF NOT EXISTS` by design (one-time
-- phpMyAdmin Import). Additive only (new tables, no change to existing tables).
-- Media bytes live in the tenant's Google Drive (drive_file_id); only metadata
-- + pipeline state are stored here.
CREATE TABLE content_items (
  id                   INT          NOT NULL AUTO_INCREMENT,
  company_id           INT          NOT NULL,
  created_by_user_id   INT          NULL,
  title                VARCHAR(200) NOT NULL,
  caption              TEXT         NULL,
  media_type           VARCHAR(16)  NOT NULL,
  drive_file_id        VARCHAR(128) NULL,
  mime                 VARCHAR(100) NULL,
  size_bytes           INT          NULL,
  status               VARCHAR(20)  NOT NULL DEFAULT 'uploaded',
  review_feedback      TEXT         NULL,
  reviewed_by_user_id  INT          NULL,
  reviewed_at          DATETIME(3)  NULL,
  scheduled_publish_at DATETIME(3)  NULL,
  published_at         DATETIME(3)  NULL,
  play_count           INT          NOT NULL DEFAULT 0,
  created_at           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)  NOT NULL,
  PRIMARY KEY (id),
  INDEX content_items_company_status_idx (company_id, status),
  INDEX content_items_company_schedule_idx (company_id, scheduled_publish_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE content_plays (
  id              INT         NOT NULL AUTO_INCREMENT,
  company_id      INT         NOT NULL,
  content_item_id INT         NOT NULL,
  user_id         INT         NULL,
  played_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX content_plays_company_item_idx (company_id, content_item_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
