-- Topic-Aware Commerce Refactor: per-conversation topic + episode state, and a
-- full dispute/support ticketing system. All additive — safe one-time import.

-- ── Conversation: topic / episode / linked-order columns ──────────────────────
ALTER TABLE `conversations`
  ADD COLUMN `ai_active_topic`       VARCHAR(24)  NULL,
  ADD COLUMN `ai_topic_started_at`   DATETIME(3)  NULL,
  ADD COLUMN `ai_topic_expires_at`   DATETIME(3)  NULL,
  ADD COLUMN `ai_episode_started_at` DATETIME(3)  NULL,
  ADD COLUMN `ai_linked_order_id`    VARCHAR(64)  NULL;

-- ── support_tickets ───────────────────────────────────────────────────────────
CREATE TABLE `support_tickets` (
  `id`                INT          NOT NULL AUTO_INCREMENT,
  `company_id`        INT          NOT NULL,
  `conversation_id`   INT          NOT NULL,
  `contact_id`        INT          NOT NULL,
  `ticket_number`     VARCHAR(24)  NOT NULL,
  `type`              VARCHAR(24)  NOT NULL,
  `status`            VARCHAR(24)  NOT NULL DEFAULT 'open',
  `linked_order_name` VARCHAR(64)  NULL,
  `description`       TEXT         NULL,
  `created_by`        VARCHAR(16)  NOT NULL,
  `assigned_user_id`  INT          NULL,
  `resolution_note`   TEXT         NULL,
  `created_at`        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`        DATETIME(3)  NOT NULL,
  `closed_at`         DATETIME(3)  NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `support_tickets_company_id_ticket_number_key` (`company_id`, `ticket_number`),
  INDEX `support_tickets_company_id_status_idx` (`company_id`, `status`),
  INDEX `support_tickets_conversation_id_idx` (`conversation_id`),
  CONSTRAINT `support_tickets_conversation_id_fkey` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `support_tickets_company_id_fkey` FOREIGN KEY (`company_id`) REFERENCES `companies` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `support_tickets_contact_id_fkey` FOREIGN KEY (`contact_id`) REFERENCES `contacts` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `support_tickets_assigned_user_id_fkey` FOREIGN KEY (`assigned_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ── ticket_events (append-only timeline) ──────────────────────────────────────
CREATE TABLE `ticket_events` (
  `id`         INT          NOT NULL AUTO_INCREMENT,
  `company_id` INT          NOT NULL,
  `ticket_id`  INT          NOT NULL,
  `kind`       VARCHAR(24)  NOT NULL,
  `body`       TEXT         NULL,
  `actor`      VARCHAR(16)  NOT NULL,
  `user_id`    INT          NULL,
  `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  INDEX `ticket_events_company_id_ticket_id_idx` (`company_id`, `ticket_id`),
  CONSTRAINT `ticket_events_ticket_id_fkey` FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
