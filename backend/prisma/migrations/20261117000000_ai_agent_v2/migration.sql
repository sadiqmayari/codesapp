-- AI Agent v2 (Nov-2026). Additive only — no existing data is removed.
--  * per-company Agent Profile (industry pack, persona, locale, skills,
--    handoff rules, business hours) + per-store AI overrides
--  * AI bookings, agent feedback, eval runs, super-admin prompt overrides
--  * store-scoped knowledge chunks (store_id, new unique key)
--  * conversation working memory / pause / handoff / resolved store
--  * usage-log context (conversation, latency, prompt version, multiplier)
--  * super-admin per-tenant AI hard-off + cap override
--  * WhatsApp number → default store

ALTER TABLE `companies`
  ADD COLUMN `ai_admin_disabled` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `ai_admin_cap_cents` INTEGER NULL;

ALTER TABLE `conversations`
  ADD COLUMN `ai_memory` JSON NULL,
  ADD COLUMN `ai_paused_until` DATETIME(3) NULL,
  ADD COLUMN `ai_handoff_at` DATETIME(3) NULL,
  ADD COLUMN `ai_store_id` INTEGER NULL;

ALTER TABLE `messages`
  ADD COLUMN `sent_by_ai` BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE `whatsapp_numbers`
  ADD COLUMN `default_store_id` INTEGER NULL;

ALTER TABLE `ai_usage_log`
  ADD COLUMN `conversation_id` INTEGER NULL,
  ADD COLUMN `latency_ms` INTEGER NULL,
  ADD COLUMN `prompt_version` VARCHAR(64) NULL,
  ADD COLUMN `success` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `multiplier_x1000` INTEGER NULL;
CREATE INDEX `ai_usage_log_company_id_conversation_id_idx` ON `ai_usage_log`(`company_id`, `conversation_id`);

-- Store-scoped knowledge. Existing rows keep store_id 0 (company-wide) until the
-- next per-store sync replaces them (indexSource also clears legacy store-0
-- product/policy rows when a real store syncs).
ALTER TABLE `ai_knowledge_chunks`
  ADD COLUMN `store_id` INTEGER NOT NULL DEFAULT 0;
ALTER TABLE `ai_knowledge_chunks`
  DROP INDEX `ai_knowledge_chunks_company_id_source_type_source_id_key`;
CREATE UNIQUE INDEX `ai_kc_scope_key`
  ON `ai_knowledge_chunks`(`company_id`, `store_id`, `source_type`, `source_id`);

CREATE TABLE `ai_agent_profiles` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `industry` VARCHAR(32) NOT NULL DEFAULT 'ecommerce',
  `agent_name` VARCHAR(80) NULL,
  `agent_role` VARCHAR(120) NULL,
  `goals` TEXT NULL,
  `do_rules` TEXT NULL,
  `dont_rules` TEXT NULL,
  `tone` TEXT NULL,
  `country_code` VARCHAR(2) NULL,
  `currency_code` VARCHAR(3) NULL,
  `currency_symbol` VARCHAR(8) NULL,
  `languages` JSON NULL,
  `mirror_language` BOOLEAN NOT NULL DEFAULT true,
  `voice_language` VARCHAR(8) NULL,
  `payment_methods` JSON NULL,
  `payment_details_encrypted` TEXT NULL,
  `skills` JSON NULL,
  `handoff` JSON NULL,
  `hours` JSON NULL,
  `engine` VARCHAR(8) NOT NULL DEFAULT 'v2',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `ai_agent_profiles_company_id_key`(`company_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_store_profiles` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `store_id` INTEGER NOT NULL,
  `brand_name` VARCHAR(120) NULL,
  `tone` TEXT NULL,
  `currency_code` VARCHAR(3) NULL,
  `currency_symbol` VARCHAR(8) NULL,
  `country_code` VARCHAR(2) NULL,
  `payment_details_encrypted` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `ai_store_profiles_store_id_key`(`store_id`),
  INDEX `ai_store_profiles_company_id_idx`(`company_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_bookings` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `conversation_id` INTEGER NULL,
  `contact_id` INTEGER NULL,
  `service` VARCHAR(120) NOT NULL,
  `resource` VARCHAR(120) NULL,
  `starts_at` DATETIME(3) NOT NULL,
  `ends_at` DATETIME(3) NOT NULL,
  `party_size` INTEGER NOT NULL DEFAULT 1,
  `name` VARCHAR(160) NULL,
  `phone` VARCHAR(32) NULL,
  `notes` TEXT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'booked',
  `created_by` VARCHAR(16) NOT NULL DEFAULT 'ai',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `ai_bookings_company_id_starts_at_idx`(`company_id`, `starts_at`),
  INDEX `ai_bookings_company_id_conversation_id_idx`(`company_id`, `conversation_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_feedback` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `company_id` INTEGER NOT NULL,
  `conversation_id` INTEGER NOT NULL,
  `message_id` INTEGER NOT NULL,
  `user_id` INTEGER NOT NULL,
  `rating` INTEGER NOT NULL,
  `reason` VARCHAR(64) NULL,
  `comment` TEXT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `ai_feedback_message_id_user_id_key`(`message_id`, `user_id`),
  INDEX `ai_feedback_company_id_created_at_idx`(`company_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_eval_runs` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `pack` VARCHAR(32) NOT NULL,
  `prompt_version` VARCHAR(64) NOT NULL,
  `model` VARCHAR(64) NOT NULL,
  `cases` INTEGER NOT NULL DEFAULT 0,
  `passed` INTEGER NOT NULL DEFAULT 0,
  `results` JSON NULL,
  `cost_micros` BIGINT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `ai_eval_runs_pack_created_at_idx`(`pack`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `ai_prompt_overrides` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `prompt_key` VARCHAR(64) NOT NULL,
  `version` VARCHAR(32) NOT NULL,
  `body` TEXT NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'draft',
  `eval_pass` DOUBLE NULL,
  `created_by` VARCHAR(120) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  INDEX `ai_prompt_overrides_prompt_key_status_idx`(`prompt_key`, `status`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Seed one profile per existing company from its current AI settings. Existing
-- tenants are Pakistani stores, so the locale follows default_country_code
-- (PK → PKR/Rs + English/Roman Urdu/Urdu). Tenants already running auto-reply
-- start in SHADOW (v1 keeps replying, v2 logs what it would send) so the new
-- brain is measured before it takes over; everyone else starts on v2.
INSERT INTO `ai_agent_profiles`
  (`company_id`, `industry`, `tone`, `country_code`, `currency_code`, `currency_symbol`,
   `languages`, `voice_language`, `payment_methods`, `engine`, `created_at`, `updated_at`)
SELECT
  c.`id`,
  'ecommerce',
  c.`ai_brand_tone`,
  UPPER(COALESCE(c.`default_country_code`, 'PK')),
  CASE WHEN UPPER(COALESCE(c.`default_country_code`, 'PK')) = 'PK' THEN 'PKR' ELSE NULL END,
  CASE WHEN UPPER(COALESCE(c.`default_country_code`, 'PK')) = 'PK' THEN 'Rs' ELSE NULL END,
  CASE WHEN UPPER(COALESCE(c.`default_country_code`, 'PK')) = 'PK'
       THEN JSON_ARRAY('English', 'Roman Urdu', 'Urdu') ELSE JSON_ARRAY('English') END,
  CASE WHEN UPPER(COALESCE(c.`default_country_code`, 'PK')) = 'PK' THEN 'ur' ELSE NULL END,
  JSON_ARRAY('cod', 'prepaid'),
  CASE WHEN c.`ai_autoreply_enabled` = 1
         OR EXISTS (SELECT 1 FROM `conversations` cv
                    WHERE cv.`company_id` = c.`id` AND cv.`ai_autoreply` = 1)
       THEN 'shadow' ELSE 'v2' END,
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `companies` c;
