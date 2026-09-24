-- Per-agent action log for the owner/admin Agent Performance report.
-- Records actions not otherwise attributed to a user (confirm/address/cancel/
-- contact_logged). Append-only, forward-only.
CREATE TABLE `agent_activity` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `order_gid` VARCHAR(255) NULL,
  `order_name` VARCHAR(64) NULL,
  `contact_id` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `agent_activity_company_id_created_at_idx`(`company_id`, `created_at`),
  INDEX `agent_activity_company_id_user_id_action_idx`(`company_id`, `user_id`, `action`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
