-- Content task assignment + workflow audit timeline. MySQL 8 — one-time
-- phpMyAdmin Import. Additive.
ALTER TABLE `content_items`
  ADD COLUMN `assignee_user_id` INT NULL,
  ADD INDEX `content_items_company_assignee_idx` (`company_id`, `assignee_user_id`);

CREATE TABLE content_events (
  id              INT         NOT NULL AUTO_INCREMENT,
  company_id      INT         NOT NULL,
  content_item_id INT         NOT NULL,
  actor_user_id   INT         NULL,
  type            VARCHAR(32) NOT NULL,
  detail          TEXT        NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  INDEX content_events_company_item_idx (company_id, content_item_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
