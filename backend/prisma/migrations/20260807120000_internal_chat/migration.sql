-- Internal team messaging (staff ↔ staff DMs + one broadcast channel) + presence.

-- Presence: record when a user's last socket closed.
ALTER TABLE `users`
  ADD COLUMN `last_seen_at` DATETIME(3) NULL AFTER `totp_secret`;

-- Threads: 1:1 dm (dm_key = "minId-maxId") or the single per-company broadcast channel.
CREATE TABLE `internal_threads` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `dm_key` VARCHAR(40) NULL,
  `name` VARCHAR(120) NULL,
  `last_message` VARCHAR(280) NULL,
  `last_message_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `internal_threads_company_id_dm_key_key` (`company_id`, `dm_key`),
  INDEX `internal_threads_company_id_last_message_at_idx` (`company_id`, `last_message_at`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `internal_thread_members` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `thread_id` INTEGER NOT NULL,
  `company_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `last_read_at` DATETIME(3) NULL,
  `unread_count` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `internal_thread_members_thread_id_user_id_key` (`thread_id`, `user_id`),
  INDEX `internal_thread_members_company_id_user_id_idx` (`company_id`, `user_id`),
  PRIMARY KEY (`id`)
);

CREATE TABLE `internal_messages` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `thread_id` INTEGER NOT NULL,
  `company_id` INTEGER NOT NULL,
  `sender_user_id` INTEGER NOT NULL,
  `message_type` VARCHAR(16) NOT NULL,
  `content` TEXT NULL,
  `media_url` VARCHAR(500) NULL,
  `media_mime` VARCHAR(120) NULL,
  `media_name` VARCHAR(255) NULL,
  `client_id` VARCHAR(64) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `internal_messages_thread_id_created_at_idx` (`thread_id`, `created_at`),
  PRIMARY KEY (`id`)
);

ALTER TABLE `internal_thread_members`
  ADD CONSTRAINT `internal_thread_members_thread_id_fkey`
  FOREIGN KEY (`thread_id`) REFERENCES `internal_threads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `internal_messages`
  ADD CONSTRAINT `internal_messages_thread_id_fkey`
  FOREIGN KEY (`thread_id`) REFERENCES `internal_threads`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
