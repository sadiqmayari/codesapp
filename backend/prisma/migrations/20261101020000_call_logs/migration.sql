-- CreateTable: call_logs (WhatsApp Business Calling via self-hosted Asterisk SIP)
CREATE TABLE `call_logs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `conversation_id` INTEGER NULL,
  `contact_id` INTEGER NULL,
  `user_id` INTEGER NULL,
  `direction` ENUM('inbound', 'outbound') NOT NULL,
  `status` ENUM('ringing', 'answered', 'missed', 'failed', 'completed') NOT NULL DEFAULT 'ringing',
  `from_number` VARCHAR(32) NULL,
  `to_number` VARCHAR(32) NULL,
  `provider_call_id` VARCHAR(128) NULL,
  `started_at` DATETIME(3) NULL,
  `answered_at` DATETIME(3) NULL,
  `ended_at` DATETIME(3) NULL,
  `duration_sec` INTEGER NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `call_logs_company_id_created_at_idx`(`company_id`, `created_at`),
  INDEX `call_logs_conversation_id_created_at_idx`(`conversation_id`, `created_at`),
  INDEX `call_logs_company_id_provider_call_id_idx`(`company_id`, `provider_call_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
