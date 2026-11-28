-- Facebook & Instagram (Meta social): Messenger + IG DMs in the inbox, FB/IG comments.
ALTER TABLE `companies` ADD COLUMN `meta_social_token_encrypted` TEXT NULL;

ALTER TABLE `contacts`
  ADD COLUMN `fb_psid` VARCHAR(64) NULL,
  ADD COLUMN `ig_sid` VARCHAR(64) NULL,
  ADD COLUMN `avatar_url` VARCHAR(1000) NULL;
CREATE INDEX `contacts_company_id_fb_psid_idx` ON `contacts`(`company_id`, `fb_psid`);
CREATE INDEX `contacts_company_id_ig_sid_idx` ON `contacts`(`company_id`, `ig_sid`);

ALTER TABLE `conversations`
  ADD COLUMN `channel` VARCHAR(16) NOT NULL DEFAULT 'whatsapp',
  ADD COLUMN `meta_page_id` INT NULL;
CREATE INDEX `conversations_company_id_channel_last_message_at_idx` ON `conversations`(`company_id`, `channel`, `last_message_at`);

CREATE TABLE `meta_pages` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `company_id` INT NOT NULL,
  `page_id` VARCHAR(64) NOT NULL,
  `name` VARCHAR(255) NOT NULL,
  `picture_url` VARCHAR(1000) NULL,
  `page_token_encrypted` TEXT NOT NULL,
  `ig_user_id` VARCHAR(64) NULL,
  `ig_username` VARCHAR(128) NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'active',
  `subscribed_fields` JSON NULL,
  `last_error` VARCHAR(500) NULL,
  `last_event_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `meta_pages_page_id_key`(`page_id`),
  UNIQUE INDEX `meta_pages_ig_user_id_key`(`ig_user_id`),
  INDEX `meta_pages_company_id_status_idx`(`company_id`, `status`),
  PRIMARY KEY (`id`)
);
